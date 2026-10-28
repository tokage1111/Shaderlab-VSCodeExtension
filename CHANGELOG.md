# Change Log

## [Unreleased]

### 追加

- 名前の変更 (F2): include 先・ShaderLab の Property・`#pragma vertex` 等を含めて一括変更
- クイックフィックス: 暗黙の切り捨てのスウィズル、名前の打ち間違い、Property の宣言の追加・CBUFFER への移動、ShaderLab / 字句の構文エラーなど

### 修正

- `CBUFFER_START(UnityPerMaterial)` の内側で `#include` したファイルの変数が CBUFFER のメンバーとして扱われず、SRP Batcher の誤った警告が出ていた
- 参照検索で、別パスの同名の構造体・メンバーまで返していた

## [0.2.0]

解析エンジンを全面的に作り直しました。

### 追加

- 条件がファイル内で確定する `#if 0` 等の無効なコードをグレーアウト表示
- 色の設定(プリセット「C#風」「テーマ標準」と項目ごとの色)
- ShaderLab / HLSL の TextMate 文法
- 診断: 構造体メンバー・スウィズル・引数の数・暗黙の型変換・`#pragma vertex` の関数・Property の宣言漏れ・SRP Batcher 互換性
- シグネチャヘルプ、アウトライン(ドキュメントシンボル)
- ShaderLab の補完(Properties / Tags / 描画ステート / Stencil)、`#pragma` の補完
- Include Tree: 未解決の include の表示、循環 include の表示、include 文の位置へ移動
- 回帰テスト(`npm test`)

### 変更

- `.shader` をパスごとの翻訳単位として解析するようにし、別パスの同名構造体・関数が混ざらないようにした
- include ファイルを、それを include している root の翻訳単位で解析するようにした(固定した root はワークスペースごとに保存)
- Unity プロジェクトのルートをファイルの位置から探すようにした(`Assets` 以下を開いた場合、複数プロジェクトに対応)
- `Packages/` の解決で、埋め込みパッケージ・`manifest.json` の `file:` 参照・`Library/PackageCache` に対応
- Include Tree の include 解決を Language Server と共通化した

### 修正

- `\` で継続する複数行の `#define` が HLSL コードとして解析され、誤った宣言や警告が出ていた
- `#include_with_pragmas` を解決できなかった
- `TEXTURE2D()` / `SAMPLER()` / `TEXTURE2D_PARAM()` / `UNITY_VERTEX_INPUT_INSTANCE_ID` 等で宣言されたシンボルが未定義扱いになっていた
- `#if` の内側にしかない include が見つからないだけで、すべての解析が不完全扱いになっていた
- `.` を入力してもメンバー補完が自動で表示されなかった
- 参照検索がトークンごとに定義検索を行い、大きなファイルで非常に遅かった
- `urpShaderLab.trace.server` の設定が反映されなかった
