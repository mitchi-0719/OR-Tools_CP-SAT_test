import argparse
from pathlib import Path
from typing import Iterable, Sequence

from ortools.sat.python import cp_model

from scheduler import (
    CSV_PATH,
    DataValidationError,
    ScheduleConfig,
    build_model,
    default_soft_weights,
    evaluate_schedule,
    export_evaluation_csv,
    export_schedule_csv,
    load_band_data,
    print_report,
    print_schedule,
    solve_schedule,
)


def parse_weight_overrides(values: Iterable[str]) -> dict[str, int]:
    weights = default_soft_weights()
    for value in values:
        try:
            rule_id, raw_weight = value.split("=", 1)
            parsed_weight = int(raw_weight)
        except ValueError as error:
            raise DataValidationError(
                f"重みは S1=2 の形式で指定してください: {value}"
            ) from error
        rule_id = rule_id.upper()
        if rule_id not in weights:
            raise DataValidationError(f"未知のソフト制約IDです: {rule_id}")
        if parsed_weight < 0:
            raise DataValidationError("重みは0以上で指定してください")
        weights[rule_id] = parsed_weight
    return weights


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CP-SATでライブの出演順を生成します")
    parser.add_argument("--csv", type=Path, default=CSV_PATH, help="入力CSV")
    parser.add_argument("--max-time", type=float, default=20.0, help="探索上限（秒）")
    parser.add_argument("--workers", type=int, default=8, help="探索ワーカー数")
    parser.add_argument(
        "--output", type=Path, default=Path(__file__).with_name("schedule_result.csv"),
        help="出演順CSVの出力先",
    )
    parser.add_argument(
        "--evaluation-output", type=Path,
        default=Path(__file__).with_name("schedule_evaluation.csv"),
        help="制約評価CSVの出力先",
    )
    parser.add_argument(
        "--weight", action="append", default=[], metavar="ID=WEIGHT",
        help="ソフト制約の重み。例: --weight S1=2（複数指定可）",
    )
    parser.add_argument(
        "--h3-across-parts", action="store_true",
        help="H3を部またぎでもリセットせず、全体位置に適用する",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        config = ScheduleConfig(
            max_time_seconds=args.max_time,
            num_workers=args.workers,
            h3_resets_between_parts=not args.h3_across_parts,
            soft_weights=parse_weight_overrides(args.weight),
        )
        data = load_band_data(args.csv)
        artifacts = build_model(data, config)
    except (OSError, DataValidationError) as error:
        print(f"モデル構築エラー: {error}")
        return 2

    print(f"入力バンド数: {len(data.bands)}")
    print(f"VPS系対象: {[data.bands[i].name for i in artifacts.vps_ids]}")
    print(
        "H3の部またぎ: "
        + ("暫定的に適用対象外" if config.h3_resets_between_parts else "全体位置で適用")
    )
    print(f"暫定ソフト制約重み: {config.soft_weights}")

    result = solve_schedule(artifacts, config)
    status_name = result.solver.status_name(result.status)
    print("\n=== ソルバー情報 ===")
    print(f"状態: {status_name}")
    print(f"探索時間: {result.solver.wall_time:.3f}秒")

    if result.status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assert result.ordered_band_ids is not None
        print(f"目的関数値: {result.solver.objective_value:.0f}")
        print(f"最良境界値: {result.solver.best_objective_bound:.0f}")
        print_schedule(data, result.ordered_band_ids)
        report = evaluate_schedule(data, result.ordered_band_ids, config)
        print_report(report)
        export_schedule_csv(data, result.ordered_band_ids, args.output)
        export_evaluation_csv(report, args.evaluation_output)
        print("\n=== ファイル出力 ===")
        print(f"出演順: {args.output.resolve()}")
        print(f"制約評価: {args.evaluation_output.resolve()}")
        return 0
    if result.status == cp_model.INFEASIBLE:
        print("ハード制約を満たす出演順はありません。制約は緩和していません。")
        return 1
    if result.status == cp_model.UNKNOWN:
        print("探索時間内に解を確認できませんでした。解なしとは断定できません。")
        return 3
    if result.status == cp_model.MODEL_INVALID:
        print("モデル構築エラー: CP-SATがモデルを無効と判定しました。")
        print(artifacts.model.validate())
        return 2
    print(f"未処理のソルバー状態です: {status_name}")
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
