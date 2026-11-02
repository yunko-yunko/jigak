#!/usr/bin/env python3
"""Prepare independent service dates with shared ephemeral grouping and public context.

Reads already downloaded official archives only. No network, credential access,
training, activation, raw-row logging, or private identifier persistence.
"""
from __future__ import annotations
import argparse
import collections
import concurrent.futures
import csv
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import sys
import zipfile

spec = importlib.util.spec_from_file_location("public_bus_preparation", Path(__file__).with_name("prepare-public-bus.py"))
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)
MAX_ARCHIVE_BYTES = 768 * 1024**2
MAX_TOTAL_SOURCE_BYTES = 8 * 1024**3 + 512 * 1024**2
MAX_OUTPUT_BYTES = 384 * 1024**2
MAX_DATES = 14
MAX_GROUPS_PER_DATE = 10_000


def inspect(path: Path) -> dict:
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise preparation.PreparationError("archive_size_bound")
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    with zipfile.ZipFile(path) as archive:
        if sum(member.file_size for member in archive.infolist()) > preparation.MAX_UNCOMPRESSED_BYTES:
            raise preparation.PreparationError("uncompressed_size_bound")
        names = [member.filename for member in archive.infolist()]
        # A missing route table is allowed here and resolved (or refused) by prepare_many.
        if any(names.count(member) != 1 for member in [preparation.TAG_MEMBER, preparation.STOP_MEMBER]) or names.count(preparation.ROUTE_MEMBER) > 1:
            raise preparation.PreparationError("required_members_missing_or_duplicate")
        observed = set()
        for index, row in enumerate(preparation.table(archive, preparation.TAG_MEMBER, {"STDR_DE"})):
            day = preparation.service_date(preparation.clean(row, "STDR_DE"))
            if day is None:
                raise preparation.PreparationError("invalid_preflight_source_date")
            observed.add(day.isoformat())
            if index >= 9_999:
                break
    if len(observed) != 1:
        raise preparation.PreparationError("nonunique_preflight_source_date")
    return {"path": path, "sha256": checksum, "sourceDate": next(iter(observed)), "bytes": path.stat().st_size,
            "hasRouteTable": names.count(preparation.ROUTE_MEMBER) == 1}


def borrow_missing_route_numbers(inspected: list[dict]) -> list[dict]:
    """A day published without its route table borrows only the route numbers that the
    previous and next service days publish identically; any other route stays excluded."""
    by_date = {item["sourceDate"]: item for item in inspected}
    fallbacks = []
    for item in inspected:
        if item["hasRouteTable"]:
            continue
        day = dt.date.fromisoformat(item["sourceDate"])
        neighbors = [by_date.get((day + dt.timedelta(days=offset)).isoformat()) for offset in (-1, 1)]
        if any(neighbor is None or not neighbor["hasRouteTable"] for neighbor in neighbors):
            raise preparation.PreparationError("route_table_neighbors_unavailable")
        tables = []
        for neighbor in neighbors:
            with zipfile.ZipFile(neighbor["path"]) as archive:
                tables.append(preparation.route_numbers(archive))
        agreed = {route: number for route, number in tables[0].items() if tables[1].get(route) == number}
        item["routeNumbers"] = agreed
        fallbacks.append({"sourceDate": item["sourceDate"], "archiveSha256": item["sha256"], "missingMember": preparation.ROUTE_MEMBER,
                          "rule": "route numbers identical on the previous and next service day; other routes excluded",
                          "neighbors": [{"sourceDate": neighbor["sourceDate"], "archiveSha256": neighbor["sha256"]} for neighbor in neighbors],
                          "agreedRoutes": len(agreed), "disagreedRoutes": len(tables[0].keys() | tables[1].keys()) - len(agreed)})
    return fallbacks


def prepare_day(item: dict, output: Path, max_groups: int, ephemeral_key: bytes) -> dict:
    records = []
    try:
        manifest = preparation.prepare(item["path"], output, context=True, grouping_key=ephemeral_key,
                    max_groups=max_groups, expected_source_dates={item["sourceDate"]},
                    max_zip_bytes=MAX_ARCHIVE_BYTES, records_out=records, write_outputs=False,
                    route_number_fallback=item.get("routeNumbers"))
        if manifest["sourceSha256"] != item["sha256"] or manifest["sourceBytes"] != item["bytes"]:
            raise preparation.PreparationError("archive_changed_after_preflight")
        if manifest["sourceDates"] and manifest["sourceDates"] != [item["sourceDate"]]:
            raise preparation.PreparationError("source_date_changed_during_full_scan")
        return {"manifest": manifest, "records": records}
    except preparation.PreparationError as error:
        return {"error": str(error)}
    except Exception:
        # Worker exceptions must not pickle or display source row values.
        return {"error": "public_bus_multiday_preparation_failed"}


def merge_prepared_batches(batch: dict, output: Path) -> dict:
    """Pure merge of complete same-session caches. Never appends new raw days."""
    output_manifest_path = Path(str(output) + ".manifest.json")
    if output.exists() or output_manifest_path.exists():
        raise preparation.PreparationError("output_already_exists")
    files = batch["batchCacheFiles"]
    session_id, max_groups = batch["batchSessionId"], batch["maxGroupsPerSourceDate"]
    if batch.get("allDatesComplete") is not True:
        raise preparation.PreparationError("incomplete_batch_cache")
    if not isinstance(session_id, str) or len(session_id) != 32 or not 1 <= len(files) <= MAX_DATES or not 1 <= max_groups <= MAX_GROUPS_PER_DATE:
        raise preparation.PreparationError("invalid_batch_cache_index")
    records, manifests, source_dates, source_shas = [], [], set(), set()
    total_bytes = 0
    for cache in files:
        records_path, manifest_path = preparation.data_path(cache["recordsPath"]), preparation.data_path(cache["manifestPath"])
        if manifest_path.stat().st_size > 1024 * 1024:
            raise preparation.PreparationError("cache_manifest_size_bound")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("batchSessionId") != session_id:
            raise preparation.PreparationError("mixed_batch_sessions")
        if len(manifest["sourceDates"]) != 1 or manifest["sourceDates"][0] in source_dates:
            raise preparation.PreparationError("duplicate_source_date")
        if manifest["sourceSha256"] in source_shas:
            raise preparation.PreparationError("duplicate_archive_sha")
        total_bytes += records_path.stat().st_size
        if total_bytes > MAX_OUTPUT_BYTES:
            raise preparation.PreparationError("merged_output_size_bound")
        with records_path.open("rb") as source:
            checksum = hashlib.file_digest(source, "sha256").hexdigest()
        if checksum != manifest["cachedRecordsSha256"] or checksum != cache["recordsSha256"]:
            raise preparation.PreparationError("batch_cache_hash_mismatch")
        date, day_records = manifest["sourceDates"][0], []
        with records_path.open() as source:
            for line in source:
                record = json.loads(line)
                if record.get("version") != 2 or record.get("sourceDate") != date or record.get("sourceArchiveSha256") != manifest["sourceSha256"]:
                    raise preparation.PreparationError("batch_cache_provenance_mismatch")
                day_records.append(record)
        if len(day_records) != manifest["outputRows"] or len(day_records) > max_groups or len({row["groupId"] for row in day_records}) != len(day_records):
            raise preparation.PreparationError("within_date_run_count_or_uniqueness_bound")
        records.extend(day_records)
        manifests.append(manifest)
        source_dates.add(date)
        source_shas.add(manifest["sourceSha256"])
    if sorted(source_dates) != batch["expectedSourceDates"]:
        raise preparation.PreparationError("batch_cache_dates_mismatch")
    manifests.sort(key=lambda manifest: manifest["sourceDates"])
    records.sort(key=lambda record: (record["startedAt"], record["groupId"]))
    before_purge = len(records)
    groups: dict[str, set[str]] = collections.defaultdict(set)
    for record in records:
        groups[record["groupId"]].add(record["sourceDate"])
    cross_date_groups = {group for group, dates in groups.items() if len(dates) > 1}
    purged_counts = collections.Counter(record["sourceDate"] for record in records if record["groupId"] in cross_date_groups)
    # The same physical night run can legitimately cross the 04:00 service-day
    # boundary. Purge ALL its selected observations, never pick a faster label.
    records = [record for record in records if record["groupId"] not in cross_date_groups]
    if len(records) > MAX_DATES * MAX_GROUPS_PER_DATE or len({record["groupId"] for record in records}) != len(records):
        raise preparation.PreparationError("merged_run_count_or_uniqueness_bound")
    encoded = [json.dumps(record, separators=(",", ":"), ensure_ascii=True) for record in records]
    byte_count = sum(len(line.encode("utf-8")) + 1 for line in encoded)
    if byte_count > MAX_OUTPUT_BYTES:
        raise preparation.PreparationError("merged_output_size_bound")
    manifest = {"version": 2, "source": "seoul-tdata-card", "sourcePage": preparation.SOURCE,
                "sourceDates": sorted(source_dates), "archives": manifests, "outputRows": len(records), "outputBytes": byte_count,
                "outputRowsBeforeCrossDatePurge": before_purge, "crossDateDuplicatePhysicalRuns": len(cross_date_groups),
                "crossDateDuplicateObservationsPurged": before_purge - len(records), "crossDatePurgedCountsBySourceDate": dict(sorted(purged_counts.items())),
                "physicalRunGroups": len({record["groupId"] for record in records}), "vehicleGroups": len({record["vehicleGroup"] for record in records}),
                "maxGroupsPerSourceDate": max_groups, "target": "bus-tag-elapsed", "timestampPrecision": "minute", "uncertaintySeconds": 60,
                "grouping": "common-session ephemeral HMAC for physical run and vehicle; key discarded",
                "batchSessionId": session_id, "batchCacheFiles": files, "routeNumberFallbacks": batch.get("routeNumberFallbacks", []),
                "duplicateSourceDatesRefused": True, "duplicateArchiveShaRefused": True, "privateIdentifiersPersisted": False,
                "publicRouteStopIdentifiersPersisted": True, "runtimeModelActivated": False, "license": "CC BY; attribution to Seoul T-DATA and T-money"}
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    preparation.restrict_private_path(output.parent)
    preparation.write_private(output, encoded)
    try:
        preparation.write_private(output_manifest_path, [json.dumps(manifest, ensure_ascii=True, indent=2)])
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return manifest


def prepare_many(inputs: list[Path], output: Path, max_groups: int = MAX_GROUPS_PER_DATE, workers: int = 2,
                 borrow_route_numbers: bool = False, route_table_policy: str | None = None, references: list[Path] | None = None) -> dict:
    if not 1 <= len(inputs) <= MAX_DATES or not 1 <= max_groups <= MAX_GROUPS_PER_DATE or not 1 <= workers <= 4:
        raise preparation.PreparationError("multiday_count_bound")
    manifest_path = Path(str(output) + ".manifest.json")
    if output.exists() or manifest_path.exists():
        raise preparation.PreparationError("output_already_exists")
    # Preflight all dates and complete file checksums before processing any
    # passenger tables. Repeated dates cannot receive new unlinkable HMAC IDs.
    inspected, checksums, source_dates = [], set(), set()
    for path in inputs:
        item = inspect(path)
        if item["sha256"] in checksums:
            raise preparation.PreparationError("duplicate_archive_sha")
        if item["sourceDate"] in source_dates:
            raise preparation.PreparationError("duplicate_source_date")
        inspected.append(item)
        checksums.add(item["sha256"])
        source_dates.add(item["sourceDate"])
    if sum(item["bytes"] for item in inspected) > MAX_TOTAL_SOURCE_BYTES:
        raise preparation.PreparationError("total_source_size_bound")
    inspected.sort(key=lambda item: item["sourceDate"])
    if route_table_policy == "nearest-consistent":
        # Reference archives are only read for their route tables; their passenger rows are never prepared.
        reference_items = [inspect(path) for path in references or []]
        fallbacks = preparation.nearest_consistent_route_numbers(inspected, reference_items)
    else:
        fallbacks = borrow_missing_route_numbers(inspected) if borrow_route_numbers or route_table_policy == "strict" else []
    if any(not item["hasRouteTable"] and "routeNumbers" not in item for item in inspected):
        raise preparation.PreparationError("route_table_missing")
    ephemeral_key = secrets.token_bytes(32)
    batch_session_id = secrets.token_hex(16)
    cache_directory = output.parent / (".public-bus-batch-" + batch_session_id)
    cache_directory.mkdir(mode=0o700)
    cache_files, errors = [], []
    # Bounded workers process full local archives; their shared grouping
    # key exists only in process memory and is never written to an artifact.
    with concurrent.futures.ProcessPoolExecutor(max_workers=min(workers, len(inspected))) as executor:
        jobs = {executor.submit(prepare_day, item, output, max_groups, ephemeral_key): item for item in inspected}
        for future in concurrent.futures.as_completed(jobs):
            result = future.result()
            if "error" in result:
                errors.append(result["error"])
                continue
            manifest = result["manifest"]
            date = jobs[future]["sourceDate"]
            cache_path = cache_directory / (date + ".jsonl")
            cache_manifest_path = Path(str(cache_path) + ".manifest.json")
            preparation.write_private(cache_path, (json.dumps(record, separators=(",", ":"), ensure_ascii=True) for record in result["records"]))
            with cache_path.open("rb") as source:
                cached_sha = hashlib.file_digest(source, "sha256").hexdigest()
            manifest.update({"batchSessionId": batch_session_id, "cachedRecordsSha256": cached_sha})
            preparation.write_private(cache_manifest_path, [json.dumps(manifest, ensure_ascii=True, indent=2)])
            cache_files.append({"sourceDate": date, "recordsPath": str(cache_path.relative_to(Path.cwd())),
                                "manifestPath": str(cache_manifest_path.relative_to(Path.cwd())), "recordsSha256": cached_sha})
            print(json.dumps({"processedSourceDate": jobs[future]["sourceDate"], "inputRows": manifest["inputRows"],
                              "outputRows": manifest["outputRows"], "eligiblePhysicalRunsBeforeSampling": manifest["eligiblePhysicalRunsBeforeSampling"]}), flush=True)
            jobs.pop(future)
    cache_files.sort(key=lambda item: item["sourceDate"])
    batch = {"version": 2, "batchSessionId": batch_session_id, "batchCacheFiles": cache_files,
             "expectedSourceDates": sorted(source_dates), "maxGroupsPerSourceDate": max_groups,
             "allDatesComplete": not errors and len(cache_files) == len(inspected), "errors": errors,
             "routeNumberFallbacks": fallbacks}
    preparation.write_private(cache_directory / "batch-index.json", [json.dumps(batch, indent=2)])
    if errors:
        raise preparation.PreparationError(errors[0])
    return merge_prepared_batches(batch, output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", nargs="+", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-groups-per-date", type=int, default=MAX_GROUPS_PER_DATE)
    # Four archives at once: about 1 GB of memory, and 14 days prepare in about half the time of two workers.
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--borrow-route-numbers", action="store_true",
                        help="let a day published without its route table use route numbers its neighbor days agree on")
    parser.add_argument("--route-table-policy", choices=("strict", "nearest-consistent"),
                        help="strict = --borrow-route-numbers; nearest-consistent borrows the nearest earlier table checked against the two before it")
    parser.add_argument("--route-table-references", nargs="*", default=[],
                        help="earlier archives read only for their route tables (nearest-consistent)")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        inputs = [preparation.data_path(value) for value in args.inputs]
        references = [preparation.data_path(value) for value in args.route_table_references]
        output = preparation.data_path(args.output)
        if not args.execute:
            print(json.dumps({"executed": False, "requiresExecute": True, "target": "bus-tag-elapsed", "version": 2}))
            return 0
        manifest = prepare_many(inputs, output, args.max_groups_per_date, args.workers, args.borrow_route_numbers, args.route_table_policy, references)
        print(json.dumps({"executed": True, "outputRows": manifest["outputRows"], "sourceDates": manifest["sourceDates"],
                          "outputBytes": manifest["outputBytes"], "runtimeModelActivated": False}))
        return 0
    except preparation.PreparationError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
    except Exception:
        print(json.dumps({"error": "public_bus_multiday_preparation_failed"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
