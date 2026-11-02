# タスク11：Vercel公開準備（2026年11月2日）

公開先はVercel。Vercelへの配置・本番URLでの確認は未実施のため、タスク11全体は未完了。

## 残した変更

- 全画面から開ける「位置情報とデータの扱い」ページと、位置共有の注意からのリンク。
- 位置の用途・保存・削除・端末保存・外部サービスと利用上の制約の説明。配信事業者をVercelに訂正した。
- 未参加で説明を開いても測位・外部通信を始めないことの回帰テスト。
- 外部埋め込み防止など既存の6つの保護ヘッダー。`vercel.json` に移し、Vite・ビルドコマンド・出力先も設定した。
- Supabaseのアクセス制限、利用上限、自動削除。公開先に依存しないため取り消さない。

## 取り消したSites専用の追加

- `scripts/build-hosting.mjs` と `public/_headers` を削除。Vercelでは `npm run build` の出力を配信する。
- Sitesの一般公開を本人限定（custom、許可はownerのみ）へ戻した。確認用サイトとDB自体は削除していない。
- Sitesへの配置を本番公開の完了とした記録を訂正。以前のSitesでの成功は検証履歴としてだけ扱う。

## Vercelで残る手順

1. リポジトリをVercelへ取り込む。FrameworkはVite、Build Commandは `npm run build`、Output Directoryは `dist`。
2. Vercelの環境変数に `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY`、`VITE_GOOGLE_MAPS_API_KEY`、`VITE_GOOGLE_MAPS_MAP_ID` を登録する。`.env.local` をGitへ追加しない。
3. 確定した本番URLをGoogle MapsキーのHTTPリファラー許可先へ登録する。現在は旧Sitesの確認用URLだけなので、VercelのURLは未登録。API制限はMaps JavaScript APIだけを維持する。
4. 配置後、ログインなしでの閲覧、説明ページ、ルーム作成・招待参加、初期OFF、地図、退出、保護ヘッダーを確認する。招待は新しい本番URLでルームを作成して行う。

## これまでの確認と制約

- 直前の作業では自動テスト102件、型チェック、ビルド、人工センサーと独立した2画面での実接続が成功。
- 以前のSites版では匿名HTTP、説明ページ、ルーム作成、初期OFF、退出と保護ヘッダーを確認済み。Vercelの動作確認には代用しない。
- iPhone Safariの実機測位・コンパス精度はタスク10の未確認項目として残す。
- Google Cloudは無料トライアルを維持。有料化せず、編集ロックにより300回／日上限は未設定。
- 今回の正本での変更は未コミット。Vercelへの公開操作は行っていない。
