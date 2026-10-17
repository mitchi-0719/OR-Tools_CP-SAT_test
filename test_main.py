import csv
import tempfile
import unittest
from pathlib import Path

from ortools.sat.python import cp_model

from scheduler import (
    ScheduleConfig,
    build_model,
    evaluate_schedule,
    export_evaluation_csv,
    export_schedule_csv,
    find_unique_band,
    load_band_data,
    part_for_position,
    solve_schedule,
)


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = load_band_data()
        cls.config = ScheduleConfig(max_time_seconds=10.0, num_workers=8)
        cls.artifacts = build_model(cls.data, cls.config)
        cls.result = solve_schedule(cls.artifacts, cls.config)
        if cls.result.status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            raise AssertionError(
                "テスト用モデルから解を得られませんでした: "
                + cls.result.solver.status_name(cls.result.status)
            )
        assert cls.result.ordered_band_ids is not None
        cls.order = cls.result.ordered_band_ids
        cls.report = evaluate_schedule(cls.data, cls.order, cls.config)

    def order_with_pair_at(self, first_name: str, second_name: str, position: int) -> list[int]:
        first = find_unique_band(self.data, first_name)
        second = find_unique_band(self.data, second_name)
        rest = [band.id for band in self.data.bands if band.id not in (first, second)]
        return rest[:position] + [first, second] + rest[position:]

    def test_same_part_shared_member_consecutive_is_violation(self) -> None:
        order = self.order_with_pair_at("Everything", "Hope/安室奈美恵", 0)
        report = evaluate_schedule(self.data, order, self.config)
        h1 = next(check for check in report.hard_checks if check.id == "H1")
        self.assertEqual(h1.status, "違反")
        self.assertTrue(any("カミムラチカ" in detail for detail in h1.details))

    def test_boundary_consecutive_shared_member_is_not_h1_violation(self) -> None:
        order = self.order_with_pair_at("Everything", "Hope/安室奈美恵", 12)
        positions = {band_id: pos for pos, band_id in enumerate(order)}
        everything = find_unique_band(self.data, "Everything")
        hope = find_unique_band(self.data, "Hope/安室奈美恵")
        self.assertEqual(abs(positions[everything] - positions[hope]), 1)
        self.assertNotEqual(
            part_for_position(positions[everything]), part_for_position(positions[hope])
        )
        report = evaluate_schedule(self.data, order, self.config)
        h1 = next(check for check in report.hard_checks if check.id == "H1")
        self.assertFalse(
            any("Everything" in detail and "Hope" in detail for detail in h1.details)
        )

    def test_second_part_fixed_first_three_slots(self) -> None:
        self.assertEqual(self.data.bands[self.order[13]].name, "月のワルツ/諫山実生")
        self.assertEqual(
            {self.data.bands[self.order[14]].name, self.data.bands[self.order[15]].name},
            {"光について/GRAPEVINE", "ソロギターメドレー"},
        )

    def test_vps_precedence(self) -> None:
        positions = {band_id: pos for pos, band_id in enumerate(self.order)}
        original = find_unique_band(self.data, "VPS/木村・奥津・山内")
        mikazuki = find_unique_band(self.data, "VPS/みかずき")
        fields = find_unique_band(self.data, "VPS / FIELD's")
        self.assertLess(positions[original], positions[mikazuki])
        self.assertLess(positions[original], positions[fields])

    def test_impossible_soft_constraint_does_not_remove_hard_solution(self) -> None:
        config = ScheduleConfig(
            max_time_seconds=10.0,
            num_workers=8,
            position_preferences={"S4": ("月のワルツ/諫山実生", 0)},
        )
        artifacts = build_model(self.data, config)
        result = solve_schedule(artifacts, config)
        self.assertIn(result.status, (cp_model.OPTIMAL, cp_model.FEASIBLE))
        assert result.ordered_band_ids is not None
        report = evaluate_schedule(self.data, result.ordered_band_ids, config)
        s4 = next(check for check in report.soft_checks if check.id == "S4")
        self.assertEqual(s4.status, "未達成")
        self.assertEqual(result.solver.value(artifacts.preference_satisfied["S4"]), 0)

    def test_model_soft_states_match_independent_evaluation(self) -> None:
        positions = {band_id: pos for pos, band_id in enumerate(self.order)}
        parts = {band_id: part_for_position(pos) for band_id, pos in positions.items()}
        solver = self.result.solver

        for pair in self.artifacts.shared_pairs:
            distance = abs(positions[pair.first] - positions[pair.second])
            expected = parts[pair.first] == parts[pair.second] and distance < 3
            self.assertEqual(
                bool(solver.value(self.artifacts.s1_violations[pair.key])), expected
            )

        for (member, part), variable in self.artifacts.s2_member_uses_part.items():
            expected = any(
                parts[band_id] == part
                for band_id in self.data.member_to_band_ids[member]
            )
            self.assertEqual(bool(solver.value(variable)), expected)

        for part, variable in self.artifacts.s3_part_over_limit.items():
            expected = sum(
                parts[band_id] == part for band_id in self.artifacts.vps_ids
            ) > 2
            self.assertEqual(bool(solver.value(variable)), expected)

        for (first, second), variable in self.artifacts.s3_consecutive.items():
            expected = abs(positions[first] - positions[second]) == 1
            self.assertEqual(bool(solver.value(variable)), expected)

        soft_by_id = {check.id: check for check in self.report.soft_checks}
        for rule_id, variable in self.artifacts.preference_satisfied.items():
            expected = soft_by_id[rule_id].status == "達成"
            self.assertEqual(bool(solver.value(variable)), expected)

        mikazuki = find_unique_band(self.data, "VPS/みかずき")
        fields = find_unique_band(self.data, "VPS / FIELD's")
        additional_expected = {
            "S7": [positions[mikazuki] < positions[fields]],
            "S8": [
                parts[find_unique_band(self.data, band_name)] != 2
                for band_name in (
                    "シャフバン2班",
                    "シャフバン3班",
                    "Hope/安室奈美恵",
                )
            ],
            "S9": [positions[find_unique_band(self.data, "Everything")] == 25],
            "S10": [parts[find_unique_band(self.data, "ATTENTION/ペンタトニックス")] == 2],
            "S11": [parts[find_unique_band(self.data, "ラブファントム/B'z")] == 2],
            "S12": [parts[find_unique_band(self.data, "源泉掛け流し/てつろう")] == 1],
        }
        for rule_id, variables in self.artifacts.additional_satisfied.items():
            self.assertEqual(
                [bool(solver.value(variable)) for variable in variables],
                additional_expected[rule_id],
            )
            report_status = soft_by_id[rule_id].status
            self.assertEqual(report_status == "達成", all(additional_expected[rule_id]))

    def test_csv_result_tables_are_exported(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            schedule_path = Path(temp_dir) / "schedule.csv"
            evaluation_path = Path(temp_dir) / "evaluation.csv"
            export_schedule_csv(self.data, self.order, schedule_path)
            export_evaluation_csv(self.report, evaluation_path)

            with schedule_path.open(encoding="utf-8-sig", newline="") as csv_file:
                schedule_rows = list(csv.reader(csv_file))
            self.assertEqual(len(schedule_rows), 39)
            self.assertEqual(
                schedule_rows[0][:5],
                ["部", "部内順", "全体順", "バンドID", "バンド名"],
            )
            self.assertEqual([row[0] for row in schedule_rows[1:14]], ["1"] * 13)
            self.assertEqual([row[0] for row in schedule_rows[14:27]], ["2"] * 13)
            self.assertEqual([row[0] for row in schedule_rows[27:]], ["3"] * 12)

            with evaluation_path.open(encoding="utf-8-sig", newline="") as csv_file:
                evaluation_rows = list(csv.reader(csv_file))
            self.assertEqual(
                evaluation_rows[0], ["種別", "制約ID", "状態", "説明", "詳細"]
            )
            exported_ids = {row[1] for row in evaluation_rows[1:]}
            self.assertTrue({"H1", "H2", "H3", "H4", "H5"} <= exported_ids)
            self.assertTrue({f"S{i}" for i in range(1, 13)} <= exported_ids)


if __name__ == "__main__":
    unittest.main()
