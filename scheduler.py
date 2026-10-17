from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from ortools.sat.python import cp_model


CSV_PATH = Path(__file__).with_name("live_band_members.csv")
EXPECTED_BAND_COUNT = 38
PART_SIZES = (13, 13, 12)
PART_STARTS = (0, 13, 26)
SOFT_SCORE_SCALE = 1_000


class DataValidationError(ValueError):
    pass


@dataclass(frozen=True)
class Band:
    id: int
    name: str
    members: tuple[str, ...]


@dataclass(frozen=True)
class ScheduleData:
    bands: tuple[Band, ...]
    name_to_ids: dict[str, tuple[int, ...]]
    member_to_band_ids: dict[str, tuple[int, ...]]


@dataclass(frozen=True)
class SharedPair:
    first: int
    second: int
    shared_members: tuple[str, ...]

    @property
    def key(self) -> tuple[int, int]:
        return (self.first, self.second)


def default_soft_weights() -> dict[str, int]:
    # 暫定値。各IDをおおむね同じ最大影響度に正規化する。
    return {rule_id: 1 for rule_id in (f"S{i}" for i in range(1, 13))}


def default_position_preferences() -> dict[str, tuple[str, int]]:
    return {
        "S4": ("ラストソング/Official髭男dism", 37),
        "S5": ("気分上々↑↑/Mihimaru GT", 0),
        "S6": ("HOT LIMIT/T.M.Revolution", 26),
    }


@dataclass
class ScheduleConfig:
    max_time_seconds: float = 20.0
    num_workers: int = 8
    random_seed: int = 0
    h1_min_distance: int = 2
    h3_min_distance: int = 4  # 間に3バンド
    # 未回答のため暫定的に、通常間隔と同じく部をまたぐ場合はリセットする。
    h3_resets_between_parts: bool = True
    soft_weights: dict[str, int] = field(default_factory=default_soft_weights)
    position_preferences: dict[str, tuple[str, int]] = field(
        default_factory=default_position_preferences
    )


@dataclass
class ModelArtifacts:
    model: cp_model.CpModel
    positions: list[cp_model.IntVar]
    parts: list[cp_model.IntVar]
    distances: dict[tuple[int, int], cp_model.IntVar]
    same_part: dict[tuple[int, int], cp_model.BoolVar]
    shared_pairs: tuple[SharedPair, ...]
    h3_pairs: tuple[tuple[int, int], ...]
    s1_violations: dict[tuple[int, int], cp_model.BoolVar]
    band_in_part: dict[tuple[int, int], cp_model.BoolVar]
    s2_member_uses_part: dict[tuple[str, int], cp_model.BoolVar]
    s3_part_over_limit: dict[int, cp_model.BoolVar]
    s3_consecutive: dict[tuple[int, int], cp_model.BoolVar]
    preference_satisfied: dict[str, cp_model.BoolVar]
    vps_ids: tuple[int, ...]
    additional_satisfied: dict[str, tuple[cp_model.BoolVar, ...]]


@dataclass(frozen=True)
class CheckResult:
    id: str
    status: str
    description: str
    details: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvaluationReport:
    hard_checks: tuple[CheckResult, ...]
    soft_checks: tuple[CheckResult, ...]


@dataclass
class SolveResult:
    status: int
    solver: cp_model.CpSolver
    ordered_band_ids: list[int] | None


def load_band_data(csv_path: Path = CSV_PATH) -> ScheduleData:
    """CSVを検証し、バンドIDとメンバーIDの対応表を作る。"""
    with csv_path.open(encoding="utf-8", newline="") as csv_file:
        rows = list(csv.reader(csv_file))
    if not rows:
        raise DataValidationError(f"CSVが空です: {csv_path}")

    expected_header = ["曲名"] + [f"メンバー{i}" for i in range(1, 8)]
    if rows[0] != expected_header:
        raise DataValidationError(
            f"CSVヘッダーが想定と異なります。想定={expected_header!r}, 実際={rows[0]!r}"
        )
    data_rows = rows[1:]
    if len(data_rows) != EXPECTED_BAND_COUNT:
        raise DataValidationError(
            f"バンド数が{EXPECTED_BAND_COUNT}ではありません: {len(data_rows)}"
        )

    bands: list[Band] = []
    name_to_ids: dict[str, list[int]] = {}
    member_to_band_ids: dict[str, list[int]] = {}
    for band_id, row in enumerate(data_rows):
        if len(row) != 8:
            raise DataValidationError(
                f"CSVの{band_id + 2}行目が8列ではありません: {len(row)}列"
            )
        name = row[0].strip()
        members = tuple(cell.strip() for cell in row[1:] if cell.strip())
        if not name:
            raise DataValidationError(f"CSVの{band_id + 2}行目の曲名が空です")
        if not members:
            raise DataValidationError(f"「{name}」にメンバーが1人もいません")
        if len(set(members)) != len(members):
            raise DataValidationError(f"「{name}」内でメンバー名が重複しています")
        bands.append(Band(band_id, name, members))
        name_to_ids.setdefault(name, []).append(band_id)
        for member in members:
            member_to_band_ids.setdefault(member, []).append(band_id)

    return ScheduleData(
        tuple(bands),
        {name: tuple(ids) for name, ids in name_to_ids.items()},
        {member: tuple(ids) for member, ids in member_to_band_ids.items()},
    )


def find_unique_band(data: ScheduleData, name: str) -> int:
    ids = data.name_to_ids.get(name, ())
    if not ids:
        raise DataValidationError(f"指定名に一致するバンドがありません: {name}")
    if len(ids) > 1:
        raise DataValidationError(f"指定名に複数の候補があります: {name} (ID={ids})")
    return ids[0]


def collect_shared_pairs(data: ScheduleData) -> tuple[SharedPair, ...]:
    pair_to_members: dict[tuple[int, int], set[str]] = {}
    for member, band_ids in data.member_to_band_ids.items():
        for index, first in enumerate(band_ids):
            for second in band_ids[index + 1 :]:
                key = (min(first, second), max(first, second))
                pair_to_members.setdefault(key, set()).add(member)
    return tuple(
        SharedPair(first, second, tuple(sorted(members)))
        for (first, second), members in sorted(pair_to_members.items())
    )


def part_for_position(position: int) -> int:
    if 0 <= position <= 12:
        return 0
    if 13 <= position <= 25:
        return 1
    if 26 <= position <= 37:
        return 2
    raise ValueError(f"出演位置が範囲外です: {position}")


def build_model(data: ScheduleData, config: ScheduleConfig) -> ModelArtifacts:
    """ハード制約と重み付きソフト制約を持つCP-SATモデルを構築する。"""
    if len(data.bands) != EXPECTED_BAND_COUNT:
        raise DataValidationError(
            f"バンド数が{EXPECTED_BAND_COUNT}ではありません: {len(data.bands)}"
        )
    valid_rule_ids = set(default_soft_weights())
    unknown = set(config.soft_weights) - valid_rule_ids
    if unknown:
        raise DataValidationError(f"未知のソフト制約IDです: {sorted(unknown)}")
    if any(value < 0 for value in config.soft_weights.values()):
        raise DataValidationError("ソフト制約の重みは0以上で指定してください")

    model = cp_model.CpModel()
    band_count = len(data.bands)
    positions = [model.new_int_var(0, band_count - 1, f"position_{b}") for b in range(band_count)]
    parts = [model.new_int_var(0, 2, f"part_{b}") for b in range(band_count)]
    model.add_all_different(positions)

    allowed_position_parts = [
        (position, part_for_position(position)) for position in range(band_count)
    ]
    for band_id in range(band_count):
        model.add_allowed_assignments(
            [positions[band_id], parts[band_id]], allowed_position_parts
        )

    band_in_part: dict[tuple[int, int], cp_model.BoolVar] = {}
    for band_id in range(band_count):
        for part in range(3):
            variable = model.new_bool_var(f"band_{band_id}_in_part_{part}")
            model.add(parts[band_id] == part).only_enforce_if(variable)
            model.add(parts[band_id] != part).only_enforce_if(variable.Not())
            band_in_part[(band_id, part)] = variable

    distances: dict[tuple[int, int], cp_model.IntVar] = {}
    same_part: dict[tuple[int, int], cp_model.BoolVar] = {}

    def pair_variables(first: int, second: int) -> tuple[cp_model.IntVar, cp_model.BoolVar]:
        key = (min(first, second), max(first, second))
        if key not in distances:
            distance = model.new_int_var(0, band_count - 1, f"distance_{key[0]}_{key[1]}")
            model.add_abs_equality(distance, positions[key[0]] - positions[key[1]])
            is_same_part = model.new_bool_var(f"same_part_{key[0]}_{key[1]}")
            model.add(parts[key[0]] == parts[key[1]]).only_enforce_if(is_same_part)
            model.add(parts[key[0]] != parts[key[1]]).only_enforce_if(is_same_part.Not())
            distances[key] = distance
            same_part[key] = is_same_part
        return distances[key], same_part[key]

    # H1
    shared_pairs = collect_shared_pairs(data)
    for pair in shared_pairs:
        distance, is_same_part = pair_variables(pair.first, pair.second)
        model.add(distance >= config.h1_min_distance).only_enforce_if(is_same_part)

    # H3
    everything = find_unique_band(data, "Everything")
    kamimura_bands = data.member_to_band_ids.get("カミムラチカ", ())
    if everything not in kamimura_bands:
        raise DataValidationError("Everythingにカミムラチカが登録されていません")
    h3_pairs: list[tuple[int, int]] = []
    for other in kamimura_bands:
        if other == everything:
            continue
        key = (min(everything, other), max(everything, other))
        distance, is_same_part = pair_variables(*key)
        constraint = model.add(distance >= config.h3_min_distance)
        if config.h3_resets_between_parts:
            constraint.only_enforce_if(is_same_part)
        h3_pairs.append(key)

    # H4
    vps_original = find_unique_band(data, "VPS/木村・奥津・山内")
    vps_mikazuki = find_unique_band(data, "VPS/みかずき")
    vps_fields = find_unique_band(data, "VPS / FIELD's")
    model.add(positions[vps_original] < positions[vps_mikazuki])
    model.add(positions[vps_original] < positions[vps_fields])

    # H5
    moon = find_unique_band(data, "月のワルツ/諫山実生")
    grapevine = find_unique_band(data, "光について/GRAPEVINE")
    solo = find_unique_band(data, "ソロギターメドレー")
    model.add(positions[moon] == 13)
    model.add_allowed_assignments([positions[grapevine]], [(14,), (15,)])
    model.add_allowed_assignments([positions[solo]], [(14,), (15,)])

    objective_terms: list = []

    def weight(rule_id: str) -> int:
        return config.soft_weights.get(rule_id, 0)

    def normalized_unit(rule_id: str, count: int) -> int:
        if count <= 0 or weight(rule_id) == 0:
            return 0
        return max(1, round(weight(rule_id) * SOFT_SCORE_SCALE / count))

    # S1: 同じ部では、可能なら間に2バンド（位置差3以上）。
    s1_violations: dict[tuple[int, int], cp_model.BoolVar] = {}
    s1_unit_weight = normalized_unit("S1", len(shared_pairs))
    for pair in shared_pairs:
        distance, is_same_part = pair_variables(*pair.key)
        is_short = model.new_bool_var(f"s1_short_{pair.first}_{pair.second}")
        model.add(distance <= 2).only_enforce_if(is_short)
        model.add(distance >= 3).only_enforce_if(is_short.Not())
        violation = model.new_bool_var(f"s1_violation_{pair.first}_{pair.second}")
        model.add(violation <= is_same_part)
        model.add(violation <= is_short)
        model.add(violation >= is_same_part + is_short - 1)
        s1_violations[pair.key] = violation
        if s1_unit_weight:
            objective_terms.append(-s1_unit_weight * violation)

    # S2: 複数回出演する人が使用する部の種類数を最大化。
    s2_member_uses_part: dict[tuple[str, int], cp_model.BoolVar] = {}
    multi_members = {
        member: ids for member, ids in data.member_to_band_ids.items() if len(ids) >= 2
    }
    max_extra_parts = sum(min(3, len(ids)) - 1 for ids in multi_members.values())
    s2_unit_weight = normalized_unit("S2", max_extra_parts)
    for member, band_ids in multi_members.items():
        used_vars = []
        for part in range(3):
            used = model.new_bool_var(f"s2_{member}_uses_part_{part}")
            occurrences = [band_in_part[(band_id, part)] for band_id in band_ids]
            for occurrence in occurrences:
                model.add_implication(occurrence, used)
            model.add_bool_or(occurrences).only_enforce_if(used)
            s2_member_uses_part[(member, part)] = used
            used_vars.append(used)
        if s2_unit_weight:
            objective_terms.append(s2_unit_weight * (sum(used_vars) - 1))

    # S3: 各部最大2組、かつVPS系同士の全体位置での連続を避ける。
    vps_ids = tuple(b.id for b in data.bands if b.name.lstrip().startswith("VPS"))
    if not vps_ids:
        raise DataValidationError("VPS系バンドが見つかりません")
    s3_part_over_limit: dict[int, cp_model.BoolVar] = {}
    s3_consecutive: dict[tuple[int, int], cp_model.BoolVar] = {}
    half_budget = weight("S3") * SOFT_SCORE_SCALE // 2
    for part in range(3):
        count = sum(band_in_part[(band_id, part)] for band_id in vps_ids)
        over = model.new_bool_var(f"s3_part_{part}_over_limit")
        model.add(count >= 3).only_enforce_if(over)
        model.add(count <= 2).only_enforce_if(over.Not())
        s3_part_over_limit[part] = over
        if half_budget:
            objective_terms.append(-half_budget * over)

    vps_pairs = [
        (first, second)
        for index, first in enumerate(vps_ids)
        for second in vps_ids[index + 1 :]
    ]
    consecutive_weight = (
        max(1, round(half_budget / len(vps_pairs))) if half_budget and vps_pairs else 0
    )
    for first, second in vps_pairs:
        key = (min(first, second), max(first, second))
        distance, _ = pair_variables(*key)
        consecutive = model.new_bool_var(f"s3_consecutive_{key[0]}_{key[1]}")
        model.add(distance == 1).only_enforce_if(consecutive)
        model.add(distance >= 2).only_enforce_if(consecutive.Not())
        s3_consecutive[key] = consecutive
        if consecutive_weight:
            objective_terms.append(-consecutive_weight * consecutive)

    # S4〜S6
    preference_satisfied: dict[str, cp_model.BoolVar] = {}
    for rule_id, (band_name, target) in config.position_preferences.items():
        band_id = find_unique_band(data, band_name)
        satisfied = model.new_bool_var(f"{rule_id.lower()}_satisfied")
        model.add(positions[band_id] == target).only_enforce_if(satisfied)
        model.add(positions[band_id] != target).only_enforce_if(satisfied.Not())
        preference_satisfied[rule_id] = satisfied
        if weight(rule_id):
            objective_terms.append(weight(rule_id) * SOFT_SCORE_SCALE * satisfied)

    # S7: VPS/みかずき を VPS / FIELD's より前にしたい。
    additional_satisfied: dict[str, tuple[cp_model.BoolVar, ...]] = {}
    s7 = model.new_bool_var("s7_mikazuki_before_fields")
    model.add(positions[vps_mikazuki] < positions[vps_fields]).only_enforce_if(s7)
    model.add(positions[vps_mikazuki] >= positions[vps_fields]).only_enforce_if(s7.Not())
    additional_satisfied["S7"] = (s7,)
    if weight("S7"):
        objective_terms.append(weight("S7") * SOFT_SCORE_SCALE * s7)

    # S8: シャフバン2班・3班とHopeを3部以外にしたい。
    s8_band_names = (
        "シャフバン2班",
        "シャフバン3班",
        "Hope/安室奈美恵",
    )
    s8_flags: list[cp_model.BoolVar] = []
    s8_unit_weight = normalized_unit("S8", len(s8_band_names))
    for band_name in s8_band_names:
        band_id = find_unique_band(data, band_name)
        satisfied = model.new_bool_var(f"s8_not_part3_{band_id}")
        model.add(parts[band_id] != 2).only_enforce_if(satisfied)
        model.add(parts[band_id] == 2).only_enforce_if(satisfied.Not())
        s8_flags.append(satisfied)
        if s8_unit_weight:
            objective_terms.append(s8_unit_weight * satisfied)
    additional_satisfied["S8"] = tuple(s8_flags)

    # S9: Everythingを2部のトリ（全体位置25）にしたい。
    s9 = model.new_bool_var("s9_everything_at_25")
    model.add(positions[everything] == 25).only_enforce_if(s9)
    model.add(positions[everything] != 25).only_enforce_if(s9.Not())
    additional_satisfied["S9"] = (s9,)
    if weight("S9"):
        objective_terms.append(weight("S9") * SOFT_SCORE_SCALE * s9)

    def add_soft_part_preference(
        rule_id: str, band_name: str, target_part: int
    ) -> None:
        band_id = find_unique_band(data, band_name)
        satisfied = model.new_bool_var(f"{rule_id.lower()}_band_{band_id}_part_{target_part}")
        model.add(parts[band_id] == target_part).only_enforce_if(satisfied)
        model.add(parts[band_id] != target_part).only_enforce_if(satisfied.Not())
        additional_satisfied[rule_id] = (satisfied,)
        if weight(rule_id):
            objective_terms.append(weight(rule_id) * SOFT_SCORE_SCALE * satisfied)

    # S10〜S12: 希望する所属部。
    add_soft_part_preference("S10", "ATTENTION/ペンタトニックス", 2)
    add_soft_part_preference("S11", "ラブファントム/B'z", 2)
    add_soft_part_preference("S12", "源泉掛け流し/てつろう", 1)

    model.maximize(sum(objective_terms))
    return ModelArtifacts(
        model, positions, parts, distances, same_part, shared_pairs, tuple(h3_pairs),
        s1_violations, band_in_part, s2_member_uses_part, s3_part_over_limit,
        s3_consecutive, preference_satisfied, vps_ids, additional_satisfied,
    )


def solve_schedule(artifacts: ModelArtifacts, config: ScheduleConfig) -> SolveResult:
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = config.max_time_seconds
    solver.parameters.num_search_workers = config.num_workers
    solver.parameters.random_seed = config.random_seed
    status = solver.solve(artifacts.model)
    order = None
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        order = sorted(
            range(len(artifacts.positions)),
            key=lambda band_id: solver.value(artifacts.positions[band_id]),
        )
    return SolveResult(status, solver, order)


def _positions_from_order(data: ScheduleData, order: Sequence[int]) -> dict[int, int]:
    if len(order) != len(data.bands):
        raise DataValidationError(
            f"出演順の件数が{len(data.bands)}ではありません: {len(order)}"
        )
    expected = set(range(len(data.bands)))
    if set(order) != expected or len(set(order)) != len(order):
        raise DataValidationError("出演順に不足・重複・不明なバンドIDがあります")
    return {band_id: position for position, band_id in enumerate(order)}


def evaluate_schedule(
    data: ScheduleData, order: Sequence[int], config: ScheduleConfig
) -> EvaluationReport:
    """ソルバーから独立して出演順を再評価する。GUIの手動順にも利用可能。"""
    position = _positions_from_order(data, order)
    part = {band_id: part_for_position(pos) for band_id, pos in position.items()}
    shared_pairs = collect_shared_pairs(data)
    hard: list[CheckResult] = []
    soft: list[CheckResult] = []

    h1_violations: list[str] = []
    h1_applicable = 0
    h1_na = 0
    for pair in shared_pairs:
        if part[pair.first] != part[pair.second]:
            h1_na += 1
            continue
        h1_applicable += 1
        distance = abs(position[pair.first] - position[pair.second])
        if distance < config.h1_min_distance:
            h1_violations.append(_pair_gap_detail(data, pair, distance))
    hard.append(CheckResult(
        "H1", "違反" if h1_violations else "達成",
        f"同じ部の対象={h1_applicable}、部またぎ（適用対象外）={h1_na}",
        tuple(h1_violations),
    ))

    actual_sizes = tuple(sum(value == p for value in part.values()) for p in range(3))
    hard.append(CheckResult(
        "H2", "達成" if actual_sizes == PART_SIZES else "違反",
        f"部別バンド数={actual_sizes}（期待={PART_SIZES}）",
    ))

    everything = find_unique_band(data, "Everything")
    h3_violations: list[str] = []
    h3_applicable = 0
    h3_na = 0
    for other in data.member_to_band_ids.get("カミムラチカ", ()):
        if other == everything:
            continue
        if config.h3_resets_between_parts and part[everything] != part[other]:
            h3_na += 1
            continue
        h3_applicable += 1
        distance = abs(position[everything] - position[other])
        if distance < config.h3_min_distance:
            h3_violations.append(
                f"Everything ↔ {data.bands[other].name} / 位置差={distance}, "
                f"間={distance - 1}バンド"
            )
    hard.append(CheckResult(
        "H3", "違反" if h3_violations else "達成",
        f"位置差4以上。適用={h3_applicable}、部またぎ（適用対象外）={h3_na}",
        tuple(h3_violations),
    ))

    original = find_unique_band(data, "VPS/木村・奥津・山内")
    mikazuki = find_unique_band(data, "VPS/みかずき")
    fields = find_unique_band(data, "VPS / FIELD's")
    h4_ok = position[original] < position[mikazuki] and position[original] < position[fields]
    hard.append(CheckResult(
        "H4", "達成" if h4_ok else "違反",
        f"位置: 木村・奥津・山内={position[original]}, みかずき={position[mikazuki]}, "
        f"FIELD's={position[fields]}",
    ))

    moon = find_unique_band(data, "月のワルツ/諫山実生")
    grapevine = find_unique_band(data, "光について/GRAPEVINE")
    solo = find_unique_band(data, "ソロギターメドレー")
    h5_ok = position[moon] == 13 and {position[grapevine], position[solo]} == {14, 15}
    hard.append(CheckResult(
        "H5", "達成" if h5_ok else "違反",
        f"位置: 月のワルツ={position[moon]}, 光について={position[grapevine]}, "
        f"ソロギターメドレー={position[solo]}",
    ))

    s1_violations: list[str] = []
    s1_applicable = 0
    s1_na = 0
    for pair in shared_pairs:
        if part[pair.first] != part[pair.second]:
            s1_na += 1
            continue
        s1_applicable += 1
        distance = abs(position[pair.first] - position[pair.second])
        if distance < 3:
            s1_violations.append(_pair_gap_detail(data, pair, distance))
    s1_status = "適用対象外" if not s1_applicable else (
        "未達成" if s1_violations else "達成"
    )
    soft.append(CheckResult(
        "S1", s1_status,
        f"同じ部で位置差3以上を希望。適用={s1_applicable}、適用対象外={s1_na}、"
        f"未達成={len(s1_violations)}",
        tuple(s1_violations),
    ))

    s2_unmet: list[str] = []
    multi_member_count = 0
    for member, band_ids in sorted(data.member_to_band_ids.items()):
        if len(band_ids) < 2:
            continue
        multi_member_count += 1
        used_parts = sorted({part[band_id] for band_id in band_ids})
        target = min(3, len(band_ids))
        if len(used_parts) < target:
            s2_unmet.append(
                f"{member}: 使用部={[p + 1 for p in used_parts]}、{len(used_parts)}/{target}部"
            )
    s2_status = "適用対象外" if not multi_member_count else (
        "未達成" if s2_unmet else "達成"
    )
    soft.append(CheckResult(
        "S2", s2_status,
        f"複数回出演メンバー={multi_member_count}、最大分散に未達={len(s2_unmet)}",
        tuple(s2_unmet),
    ))

    vps_ids = tuple(b.id for b in data.bands if b.name.lstrip().startswith("VPS"))
    vps_counts = tuple(sum(part[band_id] == p for band_id in vps_ids) for p in range(3))
    s3_details: list[str] = []
    for p, count in enumerate(vps_counts):
        if count > 2:
            s3_details.append(f"{p + 1}部にVPS系が{count}組（希望上限2組）")
    for index, first in enumerate(vps_ids):
        for second in vps_ids[index + 1:]:
            if abs(position[first] - position[second]) == 1:
                s3_details.append(
                    f"VPS系が連続: {data.bands[first].name} ↔ {data.bands[second].name}"
                )
    soft.append(CheckResult(
        "S3", "未達成" if s3_details else "達成",
        f"対象={tuple(data.bands[i].name for i in vps_ids)}、部別組数={vps_counts}",
        tuple(s3_details),
    ))

    for rule_id, (band_name, target) in config.position_preferences.items():
        band_id = find_unique_band(data, band_name)
        actual = position[band_id]
        soft.append(CheckResult(
            rule_id, "達成" if actual == target else "未達成",
            f"{band_name}: 希望位置={target}, 実際={actual}",
        ))

    mikazuki = find_unique_band(data, "VPS/みかずき")
    fields = find_unique_band(data, "VPS / FIELD's")
    s7_ok = position[mikazuki] < position[fields]
    soft.append(CheckResult(
        "S7", "達成" if s7_ok else "未達成",
        f"VPS/みかずき（位置={position[mikazuki]}）を"
        f"VPS / FIELD's（位置={position[fields]}）より前にする",
    ))

    s8_band_names = (
        "シャフバン2班",
        "シャフバン3班",
        "Hope/安室奈美恵",
    )
    s8_details: list[str] = []
    s8_locations: list[str] = []
    for band_name in s8_band_names:
        band_id = find_unique_band(data, band_name)
        actual_part = part[band_id]
        s8_locations.append(f"{band_name}={actual_part + 1}部")
        if actual_part == 2:
            s8_details.append(f"{band_name}が3部に配置されている")
    soft.append(CheckResult(
        "S8", "未達成" if s8_details else "達成",
        "シャフバン2班・3班とHopeを3部以外にする。" + "、".join(s8_locations),
        tuple(s8_details),
    ))

    everything = find_unique_band(data, "Everything")
    soft.append(CheckResult(
        "S9", "達成" if position[everything] == 25 else "未達成",
        f"Everythingを2部のトリにする。希望位置=25, 実際={position[everything]}",
    ))

    for rule_id, band_name, target_part in (
        ("S10", "ATTENTION/ペンタトニックス", 2),
        ("S11", "ラブファントム/B'z", 2),
        ("S12", "源泉掛け流し/てつろう", 1),
    ):
        band_id = find_unique_band(data, band_name)
        actual_part = part[band_id]
        soft.append(CheckResult(
            rule_id,
            "達成" if actual_part == target_part else "未達成",
            f"{band_name}: 希望={target_part + 1}部, 実際={actual_part + 1}部",
        ))
    return EvaluationReport(tuple(hard), tuple(soft))


def _pair_gap_detail(data: ScheduleData, pair: SharedPair, distance: int) -> str:
    return (
        f"共有={','.join(pair.shared_members)} / {data.bands[pair.first].name} ↔ "
        f"{data.bands[pair.second].name} / 位置差={distance}, 間={distance - 1}バンド"
    )


def print_schedule(data: ScheduleData, order: Sequence[int]) -> None:
    print("\n=== 出演順 ===")
    for position, band_id in enumerate(order):
        part = part_for_position(position)
        number = position - PART_STARTS[part] + 1
        band = data.bands[band_id]
        print(
            f"{part + 1}部 {number:02d}番（全体{position + 1:02d}番） "
            f"{band.name} | {', '.join(band.members)}"
        )


def print_report(report: EvaluationReport) -> None:
    print("\n=== ハード制約の再評価 ===")
    for check in report.hard_checks:
        print(f"[{check.id}] {check.status}: {check.description}")
        for detail in check.details:
            print(f"  - {detail}")
    print("\n=== ソフト制約の再評価 ===")
    for check in report.soft_checks:
        print(f"[{check.id}] {check.status}: {check.description}")
        for detail in check.details:
            print(f"  - {detail}")


def export_schedule_csv(
    data: ScheduleData, order: Sequence[int], output_path: Path
) -> None:
    """出演順を、Excelでも開きやすいUTF-8 BOM付きCSVとして保存する。"""
    _positions_from_order(data, order)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    header = ["部", "部内順", "全体順", "バンドID", "バンド名"] + [
        f"メンバー{i}" for i in range(1, 8)
    ]
    with output_path.open("w", encoding="utf-8-sig", newline="") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(header)
        for position, band_id in enumerate(order):
            part = part_for_position(position)
            band = data.bands[band_id]
            members = list(band.members) + [""] * (7 - len(band.members))
            writer.writerow(
                [
                    part + 1,
                    position - PART_STARTS[part] + 1,
                    position + 1,
                    band.id,
                    band.name,
                    *members,
                ]
            )


def export_evaluation_csv(report: EvaluationReport, output_path: Path) -> None:
    """ハード・ソフト制約の再評価結果を表形式で保存する。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8-sig", newline="") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["種別", "制約ID", "状態", "説明", "詳細"])
        for category, checks in (
            ("ハード制約", report.hard_checks),
            ("ソフト制約", report.soft_checks),
        ):
            for check in checks:
                details = check.details or ("",)
                for detail in details:
                    writer.writerow(
                        [category, check.id, check.status, check.description, detail]
                    )
