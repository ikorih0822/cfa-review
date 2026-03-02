# CFA Review — My Question Bank

CFAの復習用パーソナル問題バンク。間隔反復（SM-2）・日本語訳対応。

---

## デプロイ手順（GitHub Pages）

### 前提
- [Node.js](https://nodejs.org/) (v18以上) がインストールされていること
- GitHubアカウントがあること

---

### ① リポジトリを作成する

1. GitHub で新しいリポジトリを作成（例: `cfa-review`）
2. **Public** に設定する（GitHub Pages無料利用のため）

---

### ② vite.config.js を修正する

`vite.config.js` の `base` をあなたのリポジトリ名に合わせて変更します。

```js
// リポジトリ名が "cfa-review" の場合
base: '/cfa-review/',
```

---

### ③ ローカルで動作確認（任意）

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 を開いて確認。

---

### ④ GitHubにpushする

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/cfa-review.git
git push -u origin main
```

---

### ⑤ GitHub Pages を有効化する

1. GitHubのリポジトリページ → **Settings** → **Pages**
2. **Source** を `GitHub Actions` に変更して保存

---

### ⑥ 自動デプロイ

`main` ブランチにpushするたびに GitHub Actions が自動でビルド＆デプロイします。
数分後に `https://あなたのユーザー名.github.io/cfa-review/` でアクセスできます。

---

## データについて

問題データはブラウザの `localStorage` に保存されます。
- 同じブラウザ・同じデバイスであればデータは保持されます
- ブラウザのキャッシュをクリアするとデータが消えます
- 定期的に問題一覧画面からJSONエクスポートすることを推奨します（将来実装予定）

---

## 翻訳について

Google翻訳の非公式エンドポイントを使用しています（APIキー不要・無料）。
翻訳結果は必ず確認し、CFA専門用語（duration, convexity等）は手動で修正してください。
