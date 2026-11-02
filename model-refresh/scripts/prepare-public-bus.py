#!/usr/bin/env python3
"""Prepare public, minute-resolution bus tag observations for offline shadow work.

This target is bus-tag-elapsed, not pure vehicle running time, waiting time, or
the signed app-trip ETA residual target. No network access or model promotion.
Run from mvp; all inputs and private outputs must remain in ignored data/.
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import hmac
import functools
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from private_files import open_private, restrict_private_path

BUS_CODES = frozenset({"100", "101", "102", "103", "104", "105", "106", "110", "115", "120", "121", "122", "130", "131", "132", "133", "134", "135", "136", "140", "141", "142", "151", "152"})
SOURCE = "https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006"
MAX_ZIP_BYTES = 512 * 1024**2
MAX_UNCOMPRESSED_BYTES = 5 * 1024**3
KST = dt.timezone(dt.timedelta(hours=9))
TAG_MEMBER = "VW_KSCC_DX_CARD.csv"
STOP_MEMBER = "VW_KSCC_DH_CARD.csv"
ROUTE_MEMBER = "VW_KSCC_DO_CARD.csv"


class PreparationError(Exception):
    pass


def data_path(value: str) -> Path:
    # The automatic refresh points this at its model store (local folder or the bucket mount).
    root = Path(os.environ.get("JIGAK_DATA_ROOT") or Path.cwd() / "data").resolve()
    path = Path(value).resolve()
    if path == root or not path.is_relative_to(root):
        raise PreparationError("path_outside_ignored_data")
    return path


def table(archive: zipfile.ZipFile, member: str, required: set[str]):
    with archive.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
        reader = csv.DictReader(text)
        if not required.issubset(set(reader.fieldnames or [])):
            raise PreparationError("missing_required_columns")
        for row in reader:
            yield row


def clean(row: dict, key: str) -> str:
    return (row.get(key) or "").strip()


def timestamp(value: str) -> int | None:
    if len(value) != 14 or not value.isdigit():
        return None
    midnight = day_start_millis(value[:8])
    hour, minute, second = int(value[8:10]), int(value[10:12]), int(value[12:])
    if midnight is None or hour >= 24 or minute >= 60 or second >= 60:
        return None
    return midnight + (hour * 3600 + minute * 60 + second) * 1000


@functools.lru_cache(maxsize=128)
def service_date(value: str) -> dt.date | None:
    try:
        if len(value) != 8 or not value.isdigit():
            return None
        return dt.date(int(value[:4]), int(value[4:6]), int(value[6:]))
    except ValueError:
        return None


@functools.lru_cache(maxsize=128)
def day_start_millis(value: str) -> int | None:
    date = service_date(value)
    return int(dt.datetime.combine(date, dt.time(), KST).timestamp() * 1000) if date is not None else None


def metadata(archive: zipfile.ZipFile):
    positions: dict[tuple[str, str], set[tuple[int, float]]] = collections.defaultdict(set)
    invalid = set()
    duplicates = 0
    for row in table(archive, STOP_MEMBER, {"ROUTE_ID", "BSST_ID", "BSST_ORDER", "BSST_SUM_DISTANCE"}):
        key = (clean(row, "ROUTE_ID"), clean(row, "BSST_ID"))
        try:
            order = int(clean(row, "BSST_ORDER"))
            distance = float(clean(row, "BSST_SUM_DISTANCE"))
            if not all(key) or order < 0 or distance < 0 or not math.isfinite(distance):
                raise ValueError()
            item = (order, distance)
            if item in positions[key]:
                duplicates += 1
            positions[key].add(item)
        except ValueError:
            invalid.add(key)
    ambiguous = {key for key, values in positions.items() if len(values) != 1} | invalid
    unique = {key: next(iter(values)) for key, values in positions.items() if key not in ambiguous}
    return unique, ambiguous, duplicates


def coordinate(row: dict) -> tuple[float, float] | None:
    """Supplier DH fields are sometimes inverted DDmm.mmmm, not WGS84 degrees."""
    try:
        original = [float(clean(row, "BSST_LAT")), float(clean(row, "BSST_LON"))]
        if any(not math.isfinite(value) or (abs(value) > 180 and value % 100 >= 60) for value in original):
            return None
        converted = [int(value // 100) + (value % 100) / 60 if abs(value) > 180 else value for value in original]
        candidates = {(round(a, 7), round(b, 7)) for a, b in [tuple(converted), tuple(reversed(converted))]
                      if math.isfinite(a) and math.isfinite(b) and 37 < a < 38 and 126 < b < 128}
        return next(iter(candidates)) if len(candidates) == 1 else None
    except (ValueError, OverflowError):
        return None


def route_numbers(archive: zipfile.ZipFile) -> dict[str, str]:
    """Public route number per ROUTE_ID; IDs published with several numbers are left out."""
    numbers: dict[str, set[str]] = collections.defaultdict(set)
    for row in table(archive, ROUTE_MEMBER, {"ROUTE_ID", "ROUTE_NUM"}):
        route, number = clean(row, "ROUTE_ID"), clean(row, "ROUTE_NUM")
        if route:
            numbers[route].add(number)
    return {route: next(iter(values)) for route, values in numbers.items()
            if len(values) == 1 and next(iter(values)) and len(next(iter(values))) <= 64}


ROUTE_TABLE_LOOKBACK_DAYS = 7
ROUTE_TABLE_HISTORY = 3


def nearest_consistent_route_numbers(items: list[dict], references: list[dict] | None = None) -> list[dict]:
    """A day published without its route table borrows ROUTE_ID -> ROUTE_NUM from the nearest earlier table
    (at most 7 days back) when that table and the two tables before it publish no conflicting number.
    If a later day in the window has a table, only routes it numbers identically are kept. New routes stay excluded.
    items/references: dicts with sourceDate, path, sha256 and hasRouteTable; items missing a table gain routeNumbers."""
    tables = sorted((item for item in [*items, *(references or [])] if item["hasRouteTable"]), key=lambda item: item["sourceDate"])
    cache: dict[str, dict[str, str]] = {}

    def numbers(item: dict) -> dict[str, str]:
        if item["sourceDate"] not in cache:
            with zipfile.ZipFile(item["path"]) as archive:
                cache[item["sourceDate"]] = route_numbers(archive)
        return cache[item["sourceDate"]]

    fallbacks = []
    for item in sorted(items, key=lambda value: value["sourceDate"]):
        if item["hasRouteTable"]:
            continue
        day = dt.date.fromisoformat(item["sourceDate"])
        earlier = [table for table in tables if day - dt.timedelta(days=ROUTE_TABLE_LOOKBACK_DAYS) <= dt.date.fromisoformat(table["sourceDate"]) < day]
        if not earlier:
            raise PreparationError("route_table_unavailable")
        borrowed = earlier[-1]
        borrowed_day = dt.date.fromisoformat(borrowed["sourceDate"])
        history = [table for table in tables if borrowed_day - dt.timedelta(days=14) <= dt.date.fromisoformat(table["sourceDate"]) < borrowed_day][-(ROUTE_TABLE_HISTORY - 1):]
        if len(history) < ROUTE_TABLE_HISTORY - 1:
            raise PreparationError("route_table_history_insufficient")
        base = numbers(borrowed)
        conflicts = sum(1 for table in history for route, number in numbers(table).items() if route in base and base[route] != number)
        if conflicts:
            raise PreparationError("route_table_history_inconsistent")
        later = next((table for table in tables if day < dt.date.fromisoformat(table["sourceDate"]) <= day + dt.timedelta(days=ROUTE_TABLE_LOOKBACK_DAYS)), None)
        agreed = dict(base) if later is None else {route: number for route, number in base.items() if numbers(later).get(route) == number}
        item["routeNumbers"] = agreed
        fallbacks.append({"sourceDate": item["sourceDate"], "archiveSha256": item["sha256"], "missingMember": ROUTE_MEMBER,
                          "rule": "nearest earlier route table within 7 days; it and the two tables before it publish no conflicting number; a later table, if any, must agree",
                          "borrowedFrom": {"sourceDate": borrowed["sourceDate"], "archiveSha256": borrowed["sha256"]},
                          "checkedAgainst": [{"sourceDate": table["sourceDate"], "archiveSha256": table["sha256"]} for table in history],
                          "nextDay": None if later is None else {"sourceDate": later["sourceDate"], "archiveSha256": later["sha256"]},
                          "agreedRoutes": len(agreed), "droppedRoutes": len(base) - len(agreed)})
    return fallbacks


def context_metadata(archive: zipfile.ZipFile, routes: dict[str, str] | None = None):
    routes = route_numbers(archive) if routes is None else routes
    points: dict[tuple[str, str], set[tuple[int, float, float, float]]] = collections.defaultdict(set)
    invalid = set()
    for row in table(archive, STOP_MEMBER, {"ROUTE_ID", "BSST_ID", "BSST_ORDER", "BSST_SUM_DISTANCE", "BSST_LAT", "BSST_LON"}):
        key = (clean(row, "ROUTE_ID"), clean(row, "BSST_ID"))
        try:
            order, distance, position = int(clean(row, "BSST_ORDER")), float(clean(row, "BSST_SUM_DISTANCE")), coordinate(row)
            if not all(key) or order < 0 or not math.isfinite(distance) or distance < 0 or position is None:
                raise ValueError()
            points[key].add((order, distance, *position))
        except ValueError:
            invalid.add(key)
    unique = {key: next(iter(values)) for key, values in points.items() if len(values) == 1 and key not in invalid}
    ordered: dict[str, dict[int, set[tuple[float, float, float]]]] = collections.defaultdict(lambda: collections.defaultdict(set))
    for (route, _), (order, distance, lat, lon) in unique.items():
        ordered[route][order].add((distance, lat, lon))
    return routes, unique, {route: sorted(values.items()) for route, values in ordered.items()}


def public_path(ordered: dict, route: str, first: int, last: int) -> list[dict] | None:
    result = []
    previous_distance = -1
    for order, values in ordered.get(route, []):
        if not first <= order <= last:
            continue
        if len(values) != 1:
            return None
        distance, lat, lon = next(iter(values))
        if distance < previous_distance:
            return None
        previous_distance = distance
        point = {"latitude": lat, "longitude": lon}
        if not result or point != result[-1]:
            result.append(point)
    if len(result) < 2:
        return None
    # Bound context size, retaining both endpoints and original order. These
    # are public stop anchors, never a claim of a complete road polyline.
    if len(result) > 100:
        result = [result[round(index * (len(result) - 1) / 99)] for index in range(100)]
    return result


def write_private(path: Path, lines) -> None:
    # O_EXCL prevents replacing existing artifacts, including a symlink.
    output = open_private(path)
    try:
        with output:
            for line in lines:
                output.write(line + "\n")
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def prepare(input_path: Path, output_path: Path, *, context: bool = False, grouping_key: bytes | None = None,
            max_groups: int | None = None, expected_source_dates: set[str] | None = None,
            max_zip_bytes: int = MAX_ZIP_BYTES, records_out: list | None = None, write_outputs: bool = True,
            route_number_fallback: dict[str, str] | None = None) -> dict:
    # route_number_fallback is only for an archive published without its route
    # table; the caller decides which route numbers are safe to borrow.
    manifest_path = Path(str(output_path) + ".manifest.json")
    if write_outputs and (output_path.exists() or manifest_path.exists()):
        raise PreparationError("output_already_exists")
    if input_path.stat().st_size > max_zip_bytes:
        raise PreparationError("archive_size_bound")
    with input_path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    ephemeral_key = grouping_key if grouping_key is not None else secrets.token_bytes(32)
    excluded: collections.Counter = collections.Counter()
    transport_counts: collections.Counter = collections.Counter()
    observed_source_dates = set()
    # All map keys representing vehicles/card holders are non-reversible random
    # HMACs. Private source fields exist only while processing the current row.
    selected = {}
    conflicting = set()
    total_rows = valid_rows = 0
    with zipfile.ZipFile(input_path) as archive:
        members = archive.infolist()
        if sum(member.file_size for member in members) > MAX_UNCOMPRESSED_BYTES:
            raise PreparationError("uncompressed_size_bound")
        names = [member.filename for member in members]
        route_tables = 0 if route_number_fallback is not None else 1
        if names.count(TAG_MEMBER) != 1 or names.count(STOP_MEMBER) != 1 or (context and names.count(ROUTE_MEMBER) != route_tables):
            raise PreparationError("required_members_missing_or_duplicate")
        stops, ambiguous, duplicate_count = metadata(archive)
        routes, public_stops, ordered = context_metadata(archive, route_number_fallback) if context else ({}, {}, {})
        cached_path = functools.lru_cache(maxsize=8192)(lambda route, first, last: public_path(ordered, route, first, last))
        required = {"TRCR_ID", "SERIAL_NUM", "TRNS_MNS_CD", "ROUTE_ID", "VHCL_ID", "TRIP_DEPR_DTM", "RIDE_DTM", "ALGH_DTM", "RIDE_BSST_ID", "ALGH_BSST_ID", "STDR_DE"}
        for row in table(archive, TAG_MEMBER, required):
            total_rows += 1
            raw_source_day = service_date(clean(row, "STDR_DE"))
            if context and (raw_source_day is None or (expected_source_dates is not None and raw_source_day.isoformat() not in expected_source_dates)):
                raise PreparationError("source_date_changed_during_full_scan")
            mode = clean(row, "TRNS_MNS_CD")
            if mode not in BUS_CODES:
                excluded["unsupportedTransport"] += 1
                continue
            source_day = service_date(clean(row, "STDR_DE"))
            ride, alight = clean(row, "RIDE_DTM"), clean(row, "ALGH_DTM")
            start, observed = timestamp(ride), timestamp(alight)
            if source_day is None or start is None or observed is None:
                excluded["invalidTimestamp"] += 1
                continue
            observed_source_dates.add(source_day.isoformat())
            # An observed second=00 is minute precision; never claim seconds.
            if ride[-2:] != "00" or alight[-2:] != "00":
                excluded["nonMinuteTimestamp"] += 1
                continue
            service_start = day_start_millis(clean(row, "STDR_DE")) + 4 * 3600_000
            if not service_start <= start < service_start + 86400_000:
                excluded["outsideServiceDay"] += 1
                continue
            actual = (observed - start) // 1000
            if not 180 <= actual <= 10800:
                excluded["durationOutsideBounds"] += 1
                continue
            route, vehicle, departure = clean(row, "ROUTE_ID"), clean(row, "VHCL_ID"), clean(row, "TRIP_DEPR_DTM")
            departure_time = timestamp(departure)
            card, serial = clean(row, "TRCR_ID"), clean(row, "SERIAL_NUM")
            if not route or vehicle in {"", "0"} or not card or not serial or departure_time is None:
                excluded["missingPhysicalRunOrSelectionKey"] += 1
                continue
            if departure_time > start:
                excluded["departureAfterBoarding"] += 1
                continue
            origin, destination = (route, clean(row, "RIDE_BSST_ID")), (route, clean(row, "ALGH_BSST_ID"))
            if origin in ambiguous or destination in ambiguous:
                excluded["ambiguousStop"] += 1
                continue
            if origin not in stops or destination not in stops:
                excluded["missingStopMetadata"] += 1
                continue
            from_order, from_distance = stops[origin]
            to_order, to_distance = stops[destination]
            distance = to_distance - from_distance
            if to_order <= from_order or distance <= 0:
                excluded["invalidStopOrder"] += 1
                continue
            if not 100 <= distance <= 50000:
                excluded["distanceOutsideBounds"] += 1
                continue
            if context:
                if route not in routes:
                    excluded["ambiguousRouteNumber"] += 1
                    continue
                if origin not in public_stops or destination not in public_stops:
                    excluded["missingOrAmbiguousStopCoordinates"] += 1
                    continue
                path = cached_path(route, from_order, to_order)
                if path is None:
                    excluded["ambiguousOrderedPath"] += 1
                    continue
            valid_rows += 1
            run = hmac.new(ephemeral_key, (route + "|" + vehicle + "|" + departure).encode(), hashlib.sha256).hexdigest()
            # Selection is independent of measured elapsed time, prediction
            # error, weather, speed, and row ordering. No private hash persists.
            priority = hashlib.sha256(("selection-v1|" + card + "|" + serial).encode()).hexdigest()
            public_od = json.dumps([route, origin[1], destination[1]], separators=(",", ":"), ensure_ascii=True)
            safe = {"version": 1, "groupId": "bus_run_" + run, "odGroup": "bus_od_" + hashlib.sha256(public_od.encode()).hexdigest(),
                    "startedAt": start, "observedAt": observed, "actualSeconds": actual, "uncertaintySeconds": 60,
                    "distanceMeters": distance, "transportCode": mode, "source": "seoul-tdata-card", "sourceDate": source_day.isoformat(), "target": "bus-tag-elapsed"}
            if context:
                first, last = public_stops[origin], public_stops[destination]
                safe.update({"version": 2, "routeId": route, "routeNumber": routes[route], "fromStopId": origin[1], "toStopId": destination[1],
                             "fromOrder": from_order, "toOrder": to_order, "fromLatitude": first[2], "fromLongitude": first[3],
                             "toLatitude": last[2], "toLongitude": last[3], "pathStopCoordinates": path,
                             "vehicleGroup": "bus_vehicle_" + hmac.new(ephemeral_key, ("vehicle|" + vehicle).encode(), hashlib.sha256).hexdigest(),
                             "sourceArchiveSha256": checksum})
            sample_priority = hashlib.sha256(("run-sample-v1|" + route + "|" + vehicle + "|" + departure).encode()).hexdigest()
            previous = selected.get(run)
            if previous is None or priority < previous[0]:
                selected[run] = (priority, safe, sample_priority)
                # Only conflicts for the currently winning passenger matter.
                # A discarded higher-priority passenger must not suppress the
                # lower fixed hash winner based on CSV ordering.
                conflicting.discard(run)
            elif priority == previous[0] and safe != previous[1]:
                conflicting.add(run)
        chosen = [(sample_priority, safe) for run, (_, safe, sample_priority) in selected.items() if run not in conflicting]
        before_sampling = len(chosen)
        if max_groups is not None:
            chosen = sorted(chosen, key=lambda item: item[0])[:max_groups]
        output_rows = [safe for _, safe in chosen]
        output_rows.sort(key=lambda record: (record["startedAt"], record["groupId"]))
        for safe in output_rows:
            safe["id"] = "bus_obs_" + uuid.uuid4().hex
            transport_counts[safe["transportCode"]] += 1
        filename_dates = re.findall(r"(?<!\d)(20\d{6})(?!\d)", input_path.name)
        filename_date = service_date(filename_dates[-1]).isoformat() if filename_dates and service_date(filename_dates[-1]) else None
        manifest = {"version": 1, "source": "seoul-tdata-card", "sourcePage": SOURCE, "sourceArchiveName": input_path.name,
                    "sourceSha256": checksum, "sourceBytes": input_path.stat().st_size, "sourceDates": sorted(observed_source_dates),
                    "fileDate": filename_date, "fileDateMatchesSourceDates": bool(filename_date and observed_source_dates == {filename_date}),
                    "license": "CC BY; attribution to Seoul T-DATA and T-money", "target": "bus-tag-elapsed", "timestampPrecision": "minute",
                    "uncertaintySeconds": 60, "inputRows": total_rows, "eligiblePassengerRows": valid_rows, "outputRows": len(output_rows),
                    "conflictingSelectionGroups": len(conflicting), "exactDuplicateMetadataRows": duplicate_count,
                    "ambiguousRouteStopKeys": len(ambiguous), "excluded": dict(excluded), "outputTransportCounts": dict(transport_counts),
                    "selection": "one eligible passenger per physical run, fixed SHA256 card-and-serial priority independent of elapsed time",
                    "grouping": "ephemeral HMAC of route, vehicle, run departure; key discarded", "privateIdentifiersPersisted": False,
                    "runtimeModelActivated": False, "trainingBaselineFabricated": False,
                    "startedAtRange": [min((record["startedAt"] for record in output_rows), default=None), max((record["startedAt"] for record in output_rows), default=None)]}
        if context:
            manifest.update({"version": 2, "context": "public-exact-route-stop", "eligiblePhysicalRunsBeforeSampling": before_sampling,
                             "maxGroupsPerSourceDate": max_groups, "physicalRunSampling": "lowest fixed SHA256 route vehicle departure hashes independent of target; hashes discarded",
                             "grouping": "common-session ephemeral HMAC for physical run and vehicle; key discarded", "publicRouteStopIdentifiersPersisted": True,
                             "routeNumberSource": "archive" if route_number_fallback is None else "neighbor-service-days"})
    if records_out is not None:
        records_out.extend(output_rows)
    if not write_outputs:
        return manifest
    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    restrict_private_path(output_path.parent)
    write_private(output_path, (json.dumps(record, separators=(",", ":"), ensure_ascii=True) for record in output_rows))
    try:
        write_private(manifest_path, [json.dumps(manifest, ensure_ascii=True, indent=2)])
    except Exception:
        output_path.unlink(missing_ok=True)
        raise
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--execute", action="store_true", help="Explicitly process the local archive and write private data artifacts.")
    parser.add_argument("--context", action="store_true", help="Version 2 public route/stop context for separately validated multiday training.")
    args = parser.parse_args()
    try:
        input_path, output_path = data_path(args.input), data_path(args.output)
        if not args.execute:
            print(json.dumps({"executed": False, "target": "bus-tag-elapsed", "requiresExecute": True}))
            return 0
        manifest = prepare(input_path, output_path, context=args.context, max_groups=10000 if args.context else None)
        print(json.dumps({"executed": True, "outputRows": manifest["outputRows"], "sourceDates": manifest["sourceDates"], "sourceSha256": manifest["sourceSha256"], "timestampPrecision": "minute", "runtimeModelActivated": False}))
        return 0
    except PreparationError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
    except (OSError, ValueError, zipfile.BadZipFile, KeyError, csv.Error, UnicodeError):
        # Raw exceptions can contain private CSV values or paths. Emit codes.
        print(json.dumps({"error": "public_bus_preparation_failed"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
