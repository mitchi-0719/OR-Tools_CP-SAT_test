# ライブ制約チャットの BE モック

TypeScript + Node.js + Hono + Google GenAI SDK。
指定 CSV のデータを使って BE が AIChatInput を作り、固定指示を systemInstruction、入力 JSON を contents として別々に渡します。HTTP と CLI は Gemini の生成テキストをそのまま返します。

## 準備

Node.js 20 以上を使用します。

```sh
cd gemini-hono-cli
npm install
# .env がなければ作成
cp -n .env.example .env
```

.env の GEMINI_API_KEY に Google AI Studio の API キーを設定してください。
PORT と、CLI の接続先を変える場合の HONO_URL も .env に指定できます。
モデル名は src/config.ts の MODEL を変更します。環境変数では上書きしません。

## 起動と質問

ターミナル1でサーバーを起動します。

```sh
npm run dev
```

ターミナル2で、同じ gemini-hono-cli ディレクトリから質問します。

```sh
npm run -s ask -- "Everythingを第2部にしたい"
```

継続して会話する場合:

```sh
npm run -s chat
```

対話中は直近20メッセージと承認待ちの変更案を保持します。次の自由入力は変更案への修正依頼として pendingProposal と一緒に送ります。
BE は承認要求を検証してメモリに保持し、proposalId を発行します。CLI はヘッダーからその ID を受け取り、保持された変更案を読み込みます。HTTP レスポンスと標準出力の生成テキストは整形しません。
プロンプトや操作結果は標準エラー出力に出します。-s は npm のコマンド表示を抑えるためです。
送信直前にモデル・固定システム指示・入力 JSON を、受信直後に返答本文を自動表示します。ask と chat の両方で次の順番になります。

```text
> Everythingを第2部にしたい

---LLMに送る内容---
model: ...
responseMimeType: application/json

[systemInstruction]
固定システム指示の全文

[contents: 入力 JSON]
最新状態・会話履歴・今回の発言・変更案の JSON 全体
------

---LLMからのレスポンス---
{"type":"approval_required","message":"...","actions":[...]}
------
```

送信内容の表示にはサーバーの SDK 呼び出しと同じ組み立て関数を使います。返答本文は標準出力、見出しや送信内容は標準エラー出力に出します。

対話コマンド:

- /exit: 終了
- /trace: 直前の送信内容・受信内容・BE の処理結果を表示
- /reset: 会話、変更案、現在状態を起動時の状態に戻す
- /reload: 最新の現在状態を読み込み、承認待ちの案を解除する
- /proposal data/pending-proposal.example.json: UI で編集した状態を模した変更案を読み込む
- /approve data/approval-settings.example.json: UI 設定のファイルを使って承認
- /approve: 読み込み済みの変更案から必須／任意・優先度を取り出して承認
- /reject: 現在の変更案を却下

/approve と /reject は専用エンドポイントを呼び、LLM は呼びません。
承認では proposalId と settings だけを送り、BE が保持した案に UI 設定を反映します。settings は追加・更新アクションごとに1件必要で、actionIndex は actions の0始まりの位置です。削除アクションには設定不要です。
必須／任意・優先度の対応、対象 ID、制約の妥当性、生成時と現在の updatedAt の一致を確認してから一括適用します。状態が変わっていたら HTTP 409、適用済みの案の再承認も HTTP 409 です。
承認後の制約と現在状態は BE のメモリに保持します。CLI を閉じてもサーバーの稼働中は残り、サーバー再起動時に data/context.json に戻ります。/reset は起動時の状態を BE に戻す操作です。Solver の実行は含みません。
モックは単一イベントを共有します。別の CLI で状態を変更した場合は /reload で再読込してください。
変更案の却下後も直近の会話は履歴に残りますが、pendingProposal は null に戻ります。

## 入力データ

data/context.json は ../live_band_members_reduce.csv を変換した JSON です。

- bands: 20件。CSV の曲名を bandName とし、行順に band-001 から採番。
- members: 63件。同じダミー名を1人にまとめ、ダミー003 は member-003 のように対応。
- memberships: 110件。空のメンバー欄は除き、所属する bandId / memberId を保持。

初期状態は以下で設定しています。data/context.json を編集してサーバーを再起動するか、--context で読み込めます。

- event.title: 秋ライブ
- parts: 第1〜3部、sortOrder は 0〜2
- constraints: []
- currentPlacements: []

別の初期状態や履歴、UI 編集後の変更案を使う場合:

```sh
npm run -s ask -- \
  --context data/context.json \
  --history data/recent-messages.example.json \
  --proposal data/pending-proposal.example.json \
  "やっぱり第3部にして"
```

--context は context オブジェクト、--history は今回の発言を含まない会話の配列、--proposal は { "actions": [...] } のファイルを指定します。
指定しなければ BE の最新の現在状態を使い、履歴は []、変更案は null です。単発の ask 同士では会話履歴を引き継ぎません。
--context は BE の現在状態を指定した JSON に変更します。
対話中の /proposal は hardness / priority の UI 編集を再現するための操作です。登録済みの案の対象や条件の修正は、自由入力で LLM に依頼してください。

API を呼ばず、組み立てた入力 JSON を確認する場合:

```sh
npm run -s ask -- --dry-run "Everythingを第2部にしたい"
```

## LLM との送受信を確認

メッセージを送ると、自動で logs/llm/<traceId>/ にログを保存し、サーバーと CLI に保存先を表示します。
送信内容と返答本文は同じターミナルに自動表示します。対話中に /trace と入力すると、SDK の返却オブジェクト・使用トークン数・BE の処理結果も確認できます。
別のターミナルから最新のログを見る場合:

```sh
npm run -s trace
```

特定のログを見る場合:

```sh
npm run -s trace -- <表示されたtraceId>
```

| ファイル | 確認できる内容 |
| --- | --- |
| system.md | 実際に使った固定システム指示 |
| input.json | 最新状態・会話履歴・今回の発言・修正対象の変更案 |
| request.json | model / contents / config を含む Gemini SDK 呼び出しの引数 |
| response.json | SDK の返却オブジェクト。候補、終了理由、使用トークン数など、API が返した情報 |
| response.txt | SDK レスポンスの response.text から取り出した本文 |
| trace.json | 開始・終了日時、所要時間、BE の出力検証結果、proposalId |
| error.json | 失敗した場合のエラー内容・API のステータス |

送信は config.systemInstruction と contents を分けて行い、返却は SDK の response.text を HTTP の text/plain に載せる流れです。
request.json / response.json は SDK の引数・返却オブジェクトを記録したものです。
本文が返らなかった場合も response.json のフィードバックや error.json を確認できます。
API キー・認証ヘッダーなどはログ上でマスクし、ログは Git の追跡対象から除外しています。
HTTP の X-Trace-Id ヘッダーから、その呼び出しのログを特定できます。

## 返答形式

固定指示 prompts/system.md と src/types.ts の AIChatOutput に次の JSON 形式を定義しています。

```json
{
  "type": "approval_required",
  "message": "Everythingを第2部に配置する条件を追加します。必須／任意を設定して承認してください。",
  "actions": [
    {
      "type": "add_constraint",
      "constraint": {
        "type": "in_range",
        "targets": { "band_ids": ["band-003"] },
        "params": { "kind": "parts", "part_ids": [1] },
        "hardness": null,
        "priority": null
      }
    }
  ]
}
```

type は approval_required / clarification_required / answer。
承認要求の actions は1件以上、確認質問と通常回答では []。確認が必要なターンには変更案を一部だけ出さず、回答を受けてからまとめて提示します。
update_constraint は変更後の制約1件を丸ごと返します。変更しない hardness / priority は現在値を引き継ぎ、pendingProposal の修正でも UI で設定済みの値を維持します。
サーバーは生成された本文を text/plain で返します。モデルの JSON 生成モードは有効です。
承認管理のための検証は本文の返却とは別に行います。不正な出力は修復せずそのまま返し、承認対象には登録しません。その場合は X-Proposal-Status: invalid_output が付き、CLI は標準エラー出力に理由を表示します。
proposalId は BE が発行し、LLM の出力には含めません。

制約は before / at_position / min_gap_member / min_gap_bands / in_range / count の6種類です。
外側は camelCase、制約の中は既存 Schema と同じ snake_case。
制約の part_ids は文字列の partId ではなく整数の sortOrder を使います。

## HTTP

通常はメッセージだけで、BE が既定の context と空の履歴・変更案を補います。

```sh
curl -sS http://127.0.0.1:3000/chat \
  -H 'content-type: application/json' \
  -d '{"userMessage":"Everythingを第2部にしたい"}'
```

POST /chat に AIChatInput 全体を送ることもできます。context は GET /context で取得した最新の現在状態と一致させてください。

HTTP のエンドポイント:

- GET /context: { context, updatedAt } を取得
- PUT /context: { context, updatedAt } で現在状態を変更。updatedAt が一致しなければ HTTP 409
- POST /chat: LLM の生成テキストをそのまま返す。承認要求の X-Proposal-Id ヘッダーに BE が発行した ID、X-Event-Updated-At に生成時のイベントの更新日時を返す
- GET /proposals/:proposalId: BE が保持した ApprovalResponse（type / message / proposalId / actions）を取得
- POST /proposals/approve: { proposalId, settings } を受けて適用
- POST /proposals/reject: { proposalId } を受けて却下

修正依頼の POST /chat では、UI 設定を反映した pendingProposal と X-Pending-Proposal-Id ヘッダーを送ります。新しい承認要求が生成されると、元の ID は置換済みになります。
承認・却下のレスポンスは { context, updatedAt, proposalId, status } です。updatedAt は BE が管理するメタデータで、LLM に送る AIChatInput には加えません。
入力不備は HTTP 400、存在しない proposalId は HTTP 404、状態の競合は HTTP 409、Gemini API の失敗は HTTP 502 です。

承認リクエストの例:

```json
{
  "proposalId": "X-Proposal-Id に返された ID",
  "settings": [
    { "actionIndex": 0, "hardness": "soft", "priority": "high" }
  ]
}
```

## 確認

```sh
npm run typecheck
npm test
```

テストは Gemini の実 API を呼ばず、入力の組み立て、生テキスト返却、ID と Schema、承認・却下の分岐を確認します。

制約の原本: [BE - Solver API設計](https://app.notion.com/p/3fbd2e9e813c801fb272c4bf74f17f9c)、
[constraint.schema.json と参照先](https://github.com/jphacks/tka_2604/blob/main/apps/schema/constraint.schema.json)。
schemas/ はこの Schema のスナップショットです。提案用の hardness / priority の null 許容は BE 側で派生させています。
