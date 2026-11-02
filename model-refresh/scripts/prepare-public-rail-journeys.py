#!/usr/bin/env python3
"""Prepare public gate-to-gate and complete mixed transit tag chains.

No network, training, model activation, or raw identifier persistence. The
observed chain starts at its first boarding tag and ends at its final alighting
tag. It does not measure initial/final walking or split transfer gaps into
walking and waiting. Source: Seoul T-DATA / T-money, CC BY.
"""
from __future__ import annotations
import argparse
import collections
import concurrent.futures
import functools
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import zipfile

spec = importlib.util.spec_from_file_location("public_bus_preparation", Path(__file__).with_name("prepare-public-bus.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
RAIL_CODES = frozenset({"200", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "231", "232", "234", "235", "236", "237", "290"})
STATION_MEMBER = "VW_KSCC_DV_CARD.csv"
SOURCE_PAGE = "https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006"
CODE_TABLE = "https://t-data.seoul.go.kr/dataprovide/download.do?id=10002"
MAX_ARCHIVE_BYTES = 768 * 1024**2
MAX_TOTAL_BYTES = 9 * 1024**3
MAX_OUTPUT_BYTES = 384 * 1024**2
MAX_ROWS_PER_TARGET_DAY = 10_000
MAX_SELECTED_GROUPS = 250_000
MAX_SELECTED_ROWS = 400_000
REQUIRED = {"TRCR_ID", "SERIAL_NUM", "TRNC_ID", "TRTR_FCNT", "TRNS_MNS_CD", "ROUTE_ID", "RIDE_BSST_ID", "ALGH_BSST_ID", "RIDE_DTM", "ALGH_DTM", "STDR_DE"}


def digest(key: bytes, *parts: str) -> str:
    return hmac.new(key, "|".join(parts).encode(), hashlib.sha256).hexdigest()


def metadata(archive: zipfile.ZipFile, route_numbers: dict | None = None):
    stations = collections.defaultdict(set)
    for row in base.table(archive, STATION_MEMBER, {"OUT_STN_NUM", "STN_KR_NM", "USE_YN"}):
        if base.clean(row, "USE_YN") == "Y":
            stations[base.clean(row, "OUT_STN_NUM")].add(base.clean(row, "STN_KR_NM"))
    station_names = {code: next(iter(names)) for code, names in stations.items() if code and len(names) == 1 and next(iter(names))}
    stops = collections.defaultdict(set)
    invalid_stops = set()
    for row in base.table(archive, base.STOP_MEMBER, {"ROUTE_ID", "BSST_ID", "BSST_NM", "BSST_ORDER", "BSST_SUM_DISTANCE"}):
        key = base.clean(row, "ROUTE_ID"), base.clean(row, "BSST_ID")
        try:
            name = base.clean(row, "BSST_NM")
            order, distance = int(base.clean(row, "BSST_ORDER")), float(base.clean(row, "BSST_SUM_DISTANCE"))
            if not all(key) or not name or order < 0 or not 0 <= distance <= 1_000_000:
                raise ValueError()
            stops[key].add((name, order, distance))
        except (ValueError, OverflowError):
            invalid_stops.add(key)
    stop_data = {key: next(iter(values)) for key, values in stops.items() if len(values) == 1 and key not in invalid_stops}
    if route_numbers is not None:
        # Borrowed under the nearest-consistent policy for a day published without its route table.
        return station_names, stop_data, dict(route_numbers)
    routes = collections.defaultdict(set)
    for row in base.table(archive, base.ROUTE_MEMBER, {"ROUTE_ID", "ROUTE_NUM"}):
        routes[base.clean(row, "ROUTE_ID")].add(base.clean(row, "ROUTE_NUM"))
    numbers = {route: next(iter(values)) for route, values in routes.items() if route and len(values) == 1 and next(iter(values))}
    return station_names, stop_data, numbers


def inspect(path: Path, allow_missing_route_table: bool = False) -> dict:
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise base.PreparationError("archive_size_bound")
    with path.open("rb") as source:
        sha = hashlib.file_digest(source, "sha256").hexdigest()
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if any(names.count(name) != 1 for name in [base.TAG_MEMBER, base.STOP_MEMBER, STATION_MEMBER]) or names.count(base.ROUTE_MEMBER) > 1 \
                or names.count(base.ROUTE_MEMBER) == 0 and not allow_missing_route_table:
            raise base.PreparationError("required_members_missing_or_duplicate")
        if sum(member.file_size for member in archive.infolist()) > base.MAX_UNCOMPRESSED_BYTES:
            raise base.PreparationError("uncompressed_size_bound")
        dates = set()
        for index, row in enumerate(base.table(archive, base.TAG_MEMBER, REQUIRED)):
            value = base.service_date(base.clean(row, "STDR_DE"))
            if value is None:
                raise base.PreparationError("invalid_source_date")
            dates.add(value.isoformat())
            if index >= 9999:
                break
    if len(dates) != 1:
        raise base.PreparationError("nonunique_source_date")
    return {"path": path, "sourceDate": next(iter(dates)), "sha256": sha, "bytes": path.stat().st_size, "hasRouteTable": names.count(base.ROUTE_MEMBER) == 1}


def leg_for(row: dict, station_names: dict, stops: dict, numbers: dict, start: int | None, end: int | None, date: str):
    mode = base.clean(row, "TRNS_MNS_CD")
    if mode not in RAIL_CODES and mode not in base.BUS_CODES:
        return None, "unsupportedTransport"
    if start is None or end is None:
        return None, "invalidTimestamp"
    if not base.clean(row, "RIDE_DTM").endswith("00") or not base.clean(row, "ALGH_DTM").endswith("00"):
        return None, "nonMinuteTimestamp"
    service_start = base.day_start_millis(date.replace("-", "")) + 4 * 3600_000
    if not service_start <= start < service_start + 86400_000:
        return None, "outsideServiceDay"
    if not 180 <= (end - start) / 1000 <= 10800:
        return None, "durationOutsideBounds"
    origin, destination = base.clean(row, "RIDE_BSST_ID"), base.clean(row, "ALGH_BSST_ID")
    if not origin or origin == destination:
        return None, "sameOrMissingEndpoint"
    if mode in RAIL_CODES:
        if origin not in station_names or destination not in station_names:
            return None, "uncoveredRailStation"
        leg = {"mode": "subway", "originName": station_names[origin], "destinationName": station_names[destination], "startedAt": start, "observedAt": end}
        return (leg, origin, destination, mode), None
    route = base.clean(row, "ROUTE_ID")
    first, last = stops.get((route, origin)), stops.get((route, destination))
    if first is None or last is None or route not in numbers:
        return None, "uncoveredOrAmbiguousBusMetadata"
    if first[1] >= last[1] or first[2] >= last[2]:
        return None, "invalidBusStopOrder"
    leg = {"mode": "bus", "originName": first[0], "destinationName": last[0], "startedAt": start, "observedAt": end, "routeNumber": numbers[route]}
    return (leg, None, None, mode), None


def observation(target: str, group_id: str, journey_id: str, card: str, legs: list, stations: list, date: str, sha: str, transfer_gap: int) -> dict:
    return {"version": 1, "id": group_id, "groupId": group_id, "journeyGroup": journey_id, "cardGroup": card,
            "source": "seoul-tdata-rail" if target == "rail-gate-elapsed" else "seoul-tdata-transit-journey", "target": target,
            "sourceDate": date, "sourceArchiveSha256": sha, "startedAt": legs[0]["startedAt"], "observedAt": legs[-1]["observedAt"],
            "actualSeconds": (legs[-1]["observedAt"] - legs[0]["startedAt"]) // 1000, "uncertaintySeconds": 60,
            "originName": legs[0]["originName"], "destinationName": legs[-1]["destinationName"],
            "originStationId": stations[0][0], "destinationStationId": stations[-1][1],
            "modeSequence": [leg["mode"] for leg in legs], "transferCount": len(legs) - 1, "legCount": len(legs),
            "transferGapSeconds": transfer_gap, "legs": legs}


def prepare_day(item: dict, key: bytes, cap: int) -> dict:
    try:
        groups = collections.defaultdict(list)
        counts = collections.Counter()
        mode_counts = collections.Counter()
        excluded = collections.Counter()
        date = item["sourceDate"]
        # Grouping tokens are HMACs. This bounded in-memory selection cache and
        # the current source row are discarded; neither is persisted or logged.
        @functools.lru_cache(maxsize=8192)
        def selected_card(raw_card: str) -> bool:
            return hashlib.sha256(("rail-journey-card-selection-v1|" + raw_card).encode()).digest()[0] % 64 == 0
        with zipfile.ZipFile(item["path"]) as archive:
            stations, stops, numbers = metadata(archive, item.get("routeNumbers"))
            for row in base.table(archive, base.TAG_MEMBER, REQUIRED):
                counts["inputRows"] += 1
                if base.clean(row, "STDR_DE") != date.replace("-", ""):
                    raise base.PreparationError("source_date_changed_during_full_scan")
                mode_counts[base.clean(row, "TRNS_MNS_CD")] += 1
                raw_card = base.clean(row, "TRCR_ID")
                if not raw_card or not selected_card(raw_card):
                    continue
                counts["selectedCardRows"] += 1
                if counts["selectedCardRows"] > MAX_SELECTED_ROWS:
                    raise base.PreparationError("selected_row_count_bound")
                transfer_id = base.clean(row, "TRNC_ID")
                if not transfer_id:
                    excluded["missingTransferIdentifier"] += 1
                    continue
                group = digest(key, "purpose", raw_card, transfer_id)
                card = digest(key, "card", raw_card)
                start, end = base.timestamp(base.clean(row, "RIDE_DTM")), base.timestamp(base.clean(row, "ALGH_DTM"))
                prepared, error = leg_for(row, stations, stops, numbers, start, end, date)
                try:
                    counter = int(base.clean(row, "TRTR_FCNT"))
                    if not 0 <= counter <= 4:
                        raise ValueError()
                except ValueError:
                    counter, error = -1, "invalidTransferCounter"
                if error:
                    excluded[error] += 1
                priority = hashlib.sha256(("rail-journey-row-selection-v1|" + raw_card + "|" + base.clean(row, "SERIAL_NUM")).encode()).hexdigest()
                groups[group].append((counter, start, end, prepared, error, priority, card))
                if len(groups) > MAX_SELECTED_GROUPS:
                    raise base.PreparationError("selected_group_count_bound")
        rails, chains, purpose_windows = {}, [], []
        for purpose, values in groups.items():
            # A source can repeat an exact row; counters with conflicting values
            # remain distinct and invalidate the complete-chain interpretation.
            unique = {}
            for value in values:
                semantic = json.dumps(value[:5], separators=(",", ":"), sort_keys=True)
                if semantic in unique:
                    counts["exactDuplicateTagRows"] += 1
                    if value[5] < unique[semantic][5]:
                        unique[semantic] = value
                else:
                    unique[semantic] = value
            values = sorted(unique.values(), key=lambda value: (value[1] is None, value[1] or 0, value[0]))
            first_start = min((value[1] for value in values if value[1] is not None), default=0)
            journey = digest(key, "journey", purpose, str(first_start))
            card = values[0][6]
            last_end = max((value[2] for value in values if value[2] is not None), default=0)
            purpose_windows.append({"purpose": purpose, "journey": journey, "first": first_start, "last": last_end,
                                    "firstCounter": values[0][0], "sourceDate": date})
            for _, start, _, prepared, error, priority, _ in values:
                if error or prepared[0]["mode"] != "subway":
                    continue
                leg, origin, destination, operator = prepared
                event = digest(key, "rail-burst", origin, destination, str(start), operator)
                record = observation("rail-gate-elapsed", event, journey, card, [leg], [(origin, destination)], date, item["sha256"], 0)
                if event in rails:
                    counts["railBurstDuplicatesCollapsed"] += 1
                if event not in rails or priority < rails[event][0]:
                    rails[event] = priority, record
            if any(value[4] for value in values):
                counts["incompleteOrInvalidChains"] += 1
                continue
            if not 2 <= len(values) <= 5 or [value[0] for value in values] != list(range(len(values))):
                counts["noncontinuousOrSingleTagChains"] += 1
                continue
            prepared_legs = [value[3] for value in values]
            legs = [value[0] for value in prepared_legs]
            if set(leg["mode"] for leg in legs) != {"bus", "subway"}:
                counts["notMixedBusRailChains"] += 1
                continue
            gaps = [(later["startedAt"] - earlier["observedAt"]) // 1000 for earlier, later in zip(legs, legs[1:])]
            elapsed = (legs[-1]["observedAt"] - legs[0]["startedAt"]) // 1000
            if any(gap < 0 or gap > 7200 for gap in gaps) or not 180 <= elapsed <= 21600:
                counts["invalidTransferGapOrChainDuration"] += 1
                continue
            stations = [(value[1], value[2]) for value in prepared_legs]
            record = observation("transit-chain-elapsed", journey, journey, card, legs, stations, date, item["sha256"], sum(gaps))
            # Selection score uses only a private grouping hash, not timestamps,
            # duration, weather, endpoints, or transfer-gap outcomes.
            chains.append((hashlib.sha256(("chain-selection-v1|" + purpose).encode()).hexdigest(), record))
        selected_rails = sorted(rails.values(), key=lambda value: value[0])[:cap]
        selected_chains = sorted(chains, key=lambda value: value[0])[:cap]
        return {"rails": [value[1] for value in selected_rails], "chains": [value[1] for value in selected_chains], "purposeWindows": purpose_windows,
                "manifest": {"sourceDate": date, "sourceArchiveSha256": item["sha256"], "sourceBytes": item["bytes"],
                             "counts": dict(counts), "modeCounts": dict(sorted(mode_counts.items())), "excludedTagCounts": dict(excluded),
                             "eligibleRailBursts": len(rails), "eligibleMixedChains": len(chains), "sampledRailRows": len(selected_rails), "sampledChainRows": len(selected_chains)}}
    except base.PreparationError as error:
        return {"error": str(error)}
    except Exception:
        # Never serialize exceptions carrying a source row or private identifier.
        return {"error": "rail_journey_preparation_failed"}


def prepare(inputs: list[Path], rail_output: Path, journey_output: Path, cap: int, workers: int,
            route_table_policy: str | None = None, references: list[Path] | None = None) -> dict:
    outputs = [rail_output, journey_output, Path(str(rail_output) + ".manifest.json"), Path(str(journey_output) + ".manifest.json")]
    if len(set(outputs)) != 4 or any(path.exists() for path in outputs):
        raise base.PreparationError("output_already_exists_or_collision")
    if not 1 <= len(inputs) <= 14 or not 1 <= cap <= MAX_ROWS_PER_TARGET_DAY or not 1 <= workers <= 2:
        raise base.PreparationError("preparation_count_bound")
    borrow = route_table_policy == "nearest-consistent"
    inspected = [inspect(path, borrow) for path in inputs]
    if len({item["sha256"] for item in inspected}) != len(inspected):
        raise base.PreparationError("duplicate_archive_sha")
    if len({item["sourceDate"] for item in inspected}) != len(inspected):
        raise base.PreparationError("duplicate_source_date")
    if sum(item["bytes"] for item in inspected) > MAX_TOTAL_BYTES:
        raise base.PreparationError("total_source_size_bound")
    inspected.sort(key=lambda item: item["sourceDate"])
    fallbacks = base.nearest_consistent_route_numbers(inspected, [inspect(path, True) for path in references or []]) if borrow else []
    key = secrets.token_bytes(32)
    results = []
    with concurrent.futures.ProcessPoolExecutor(max_workers=min(workers, len(inspected))) as executor:
        jobs = {executor.submit(prepare_day, item, key, cap): item for item in inspected}
        for future in concurrent.futures.as_completed(jobs):
            result = future.result()
            if "error" in result:
                raise base.PreparationError(result["error"])
            item = jobs[future]
            if item["path"].stat().st_size != item["bytes"]:
                raise base.PreparationError("archive_changed_after_preflight")
            results.append(result)
            print(json.dumps({"completedSourceDate": item["sourceDate"], "railRows": len(result["rails"]), "chainRows": len(result["chains"])}), flush=True)
    results.sort(key=lambda result: result["manifest"]["sourceDate"])
    rail_rows = [row for result in results for row in result["rails"]]
    chain_rows = [row for result in results for row in result["chains"]]
    # A chain prefix before 04:00 can otherwise appear complete even when a
    # later transfer is supplied in the following service-day archive. Preserve
    # source completeness, not just duplicate IDs. Legitimate TRNC reuse on a
    # later day is distinguished by a new first-transfer counter and timestamps.
    windows = collections.defaultdict(list)
    for result in results:
        for window in result["purposeWindows"]:
            windows[window["purpose"]].append(window)
    split_journeys = set()
    for values in windows.values():
        values.sort(key=lambda value: value["first"])
        for left, right in zip(values, values[1:]):
            if left["sourceDate"] == right["sourceDate"] or not left["first"] or not right["first"]:
                continue
            overlaps = right["first"] <= left["last"]
            continues = right["firstCounter"] > 0 and 0 <= right["first"] - left["last"] <= 7200_000
            if overlaps or continues:
                split_journeys.update([left["journey"], right["journey"]])
    before_split_purge = len(chain_rows)
    chain_rows = [row for row in chain_rows if row["journeyGroup"] not in split_journeys]
    purged = {}
    for name, rows in [("rail", rail_rows), ("chain", chain_rows)]:
        dates = collections.defaultdict(set)
        for row in rows:
            dates[row["groupId"]].add(row["sourceDate"])
        duplicate_groups = {group for group, days in dates.items() if len(days) > 1}
        before = len(rows)
        rows[:] = [row for row in rows if row["groupId"] not in duplicate_groups]
        purged[name] = {"groups": len(duplicate_groups), "rows": before - len(rows)}
        rows.sort(key=lambda row: (row["sourceDate"], row["startedAt"], row["id"]))
    manifest = {"version": 1, "sourcePage": SOURCE_PAGE, "codeTable": CODE_TABLE, "license": "CC BY; Seoul T-DATA and T-money",
                "sourceDates": [item["sourceDate"] for item in inspected], "archives": [result["manifest"] for result in results],
                "cardSampling": {"method": "fixed-target-independent-card-SHA256-modulo", "modulus": 64}, "maxRowsPerTargetDate": cap,
                "commonSessionCardGrouping": True, "rawPrivateIdentifiersPersisted": False, "groupingKeyPersisted": False,
                "railBurstIsPhysicalVehicle": False, "railBurstDuplicatesCollapsed": sum(result["manifest"]["counts"].get("railBurstDuplicatesCollapsed", 0) for result in results),
                "crossDateSplitChainRowsPurged": before_split_purge - len(chain_rows),
                "crossDateGroupsPurged": purged, "timestampPrecision": "minute", "uncertaintySeconds": 60,
                "targets": {"rail": "rail-gate-elapsed", "chain": "transit-chain-elapsed"}, "railRows": len(rail_rows), "chainRows": len(chain_rows),
                "initialAndFinalWalkingObserved": False, "transferGapWalkingWaitSplitObserved": False, "publicRailRouteDistanceAvailable": False,
                "runtimeModelActivated": False, "routeNumberFallbacks": fallbacks}
    encoded_rail = [json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in rail_rows]
    encoded_chain = [json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in chain_rows]
    if sum(len(line.encode()) + 1 for line in encoded_rail + encoded_chain) > MAX_OUTPUT_BYTES:
        raise base.PreparationError("output_size_bound")
    for parent in {path.parent for path in outputs}:
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        base.restrict_private_path(parent)
    written = []
    try:
        for path, lines in [(rail_output, encoded_rail), (journey_output, encoded_chain), (outputs[2], [json.dumps(manifest, ensure_ascii=True, indent=2)]), (outputs[3], [json.dumps(manifest, ensure_ascii=True, indent=2)])]:
            base.write_private(path, lines)
            written.append(path)
    except Exception:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--rail-output", required=True)
    parser.add_argument("--journey-output", required=True)
    parser.add_argument("--max-rows-per-date", type=int, default=MAX_ROWS_PER_TARGET_DAY)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--route-table-policy", choices=("nearest-consistent",),
                        help="let a day published without its route table borrow the nearest earlier consistent table")
    parser.add_argument("--route-table-reference", action="append", default=[], help="earlier archive read only for its route table")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        inputs = [base.data_path(value) for value in args.input]
        references = [base.data_path(value) for value in args.route_table_reference]
        rail, chain = base.data_path(args.rail_output), base.data_path(args.journey_output)
        if not args.execute:
            print(json.dumps({"dryRun": True, "inputCount": len(inputs), "networkRequests": 0, "rawIdentifiersLogged": False}))
            return 0
        result = prepare(inputs, rail, chain, args.max_rows_per_date, args.workers, args.route_table_policy, references)
        print(json.dumps({"sourceDates": result["sourceDates"], "railRows": result["railRows"], "chainRows": result["chainRows"], "rawPrivateIdentifiersPersisted": False, "runtimeModelActivated": False}))
        return 0
    except base.PreparationError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
    except Exception:
        print(json.dumps({"error": "rail_journey_preparation_failed"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
