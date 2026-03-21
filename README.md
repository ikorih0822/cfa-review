[README.md](https://github.com/user-attachments/files/26156567/README.md)
# CFA Review App

個人用CFA試験対策アプリ。Vite + React + Firebase で構築し、GitHub Pages で配信。

🔗 **[https://ikorih0822.github.io/cfa-review/](https://ikorih0822.github.io/cfa-review/)**

---

## 主な機能

### 問題管理
- 問題の登録・編集・削除
- 分野（CFA 11トピック）・難易度の設定
- **テキスト貼り付けによる一括読み込み**
  - 通常の1問形式に対応
  - 選択肢ごとにフィードバックが付く形式に対応（`Correct Answer Feedback:` / `Incorrect Answer Feedback:`）
  - **ビニエット（大問）形式**：パッセージ文 + 複数の小問を自動分割して一括登録
- **AI による表の自動構造化**（Claude API）：表を含む問題のテキストをタブ区切り形式に変換
- 問題文・ビニエット本文内のタブ区切りテキストを**自動で表として表示**
- ビジュアル表エディター：行・列の追加・削除・セル編集、列幅のドラッグ変更、長文の折り返し表示

### 演習モード
- **SM-2 間隔反復法**による復習スケジューリング
- 3つの演習モード：復習期限の問題 / 全問シャッフル / 短問優先（外出先向け）
- **選択肢のランダムシャッフル**（毎セッションで順番が変わる）
- **Confirm Answer ボタン**：選択後に確定ボタンを押すまで正誤を表示しない
- 解答後に覚えるべきポイントをその場で編集・保存
- AI チャット：問題文・正解・解説を文脈として Claude に質問
- AI チャット履歴の保存・閲覧・削除
- **ビニエット問題**：パッセージを折りたたみ表示（表も整形表示）
- 関連問題リンク

### 問題一覧
- 分野・難易度・SM-2 ステータスでフィルタリング
- 登録順 / 復習順 の切り替え
- 単問演習へのショートカット

### 解答履歴
- 総合正答率・総解答回数のサマリー
- 問題ごとの解答回数・正解数・不正解数・最終解答日・正答率
- 分野フィルター、最近解いた順 / 間違い率順 / 分野順でのソート
- **正答率が低い問題（2回以上解いて70%未満）に類題生成ボタン**
  - Claude API が同じ概念の新問題を自動生成
  - そのまま解いて、登録して問題バンクに追加

### ノート機能
- **リッチテキストエディター**：太字・イタリック・下線・見出しサイズ・箇条書き・文字色・蛍光ペン
- 問題との紐づけ
- 作成日・更新日の記録
- 閲覧専用画面（書式付きで表示）

### 翻訳
- 問題文・解説・選択肢を日本語訳（MyMemory API）
- まとめて自動翻訳ボタン

### データ管理
- Firebase Firestore によるクラウド同期（Google アカウントでログイン）
- 既存の localStorage データの自動マイグレーション

---

## 技術スタック

| 項目 | 内容 |
|---|---|
| フロントエンド | Vite + React（JSX、Hooks） |
| 認証 | Firebase Authentication（Google ログイン） |
| DB | Firebase Firestore |
| AI | Anthropic Claude API（`claude-sonnet-4-20250514`） |
| 翻訳 | MyMemory API |
| ホスティング | GitHub Pages |
| CI/CD | GitHub Actions |

---

## セットアップ

```bash
npm install
npm run dev
```

### 環境変数 / 設定

Firebase の設定は `src/App.jsx` 内の `firebaseConfig` に直接記載。

Claude API キーはアプリ内の設定（⚙️）から入力。localStorage に保存され、Firebase には同期されない。

---

## デプロイ

`main` ブランチへのプッシュで GitHub Actions が自動ビルド・デプロイ。

```bash
git add src/App.jsx
git commit -m "update"
git push
```

---

## データ構造（Firestore）

```
users/
  {uid}/
    data/
      questions:  { list: Question[] }
      notes:      { list: Note[] }
```

### Question フィールド

| フィールド | 型 | 説明 |
|---|---|---|
| id | string | タイムスタンプベースのID |
| topic | string | CFA トピック |
| difficulty | string | Easy / Medium / Hard |
| questionEN | string | 問題文（タブ区切りで表を含む場合あり） |
| vignetteText | string | ビニエット本文（任意） |
| choices | string[] | 選択肢 |
| correctIndex | number | 正解のインデックス |
| explanationEN | string | 解説 |
| keyPoints | string | 覚えるべきポイント |
| attemptCount | number | 解答回数 |
| wrongCount | number | 不正解回数 |
| lastAttempted | string | 最終解答日時（ISO） |
| srInterval | number | SM-2 復習間隔（日） |
| srEaseFactor | number | SM-2 難易係数 |
| srRepetitions | number | SM-2 連続正解数 |
| srNextReview | string | 次回復習予定日 |
| savedChats | object[] | 保存済み AI チャット履歴 |
| relatedIds | string[] | 関連問題 ID |
