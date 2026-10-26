# URP ShaderLab Tools

Unity URP 向けの ShaderLab / HLSL 用 VS Code 拡張機能です。
`.shader` / `.hlsl` / `.hlsli` / `.cginc` / `.compute` を解析し、補完・定義ジャンプ・参照検索・エラー表示を提供します。

## 機能

| 機能 | 内容 |
| --- | --- |
| シンタックスハイライト | ShaderLab・HLSL の TextMate 文法 + 解析結果に基づくセマンティックハイライト |
| 補完 | ローカル変数・引数、include先の関数/構造体/マクロ、構造体メンバー、スウィズル、テクスチャのメソッド、組み込み関数・型、セマンティクス、`#include` のパス、`#pragma`、ShaderLab の構文(Properties / Tags / 描画ステート) |
| Hover | 宣言(関数のオーバーロード、構造体の中身、マクロ本体)と定義場所 |
| 定義へ移動 (F12) | ローカル変数(ブロックのシャドーイング対応)、`a.b.c` / `GetFoo().x` などのメンバー、include先、`#include` のファイル、Property → CBUFFER 内の宣言 |
| 参照検索 (Shift+F12) | root から見た翻訳単位全体を検索。構造体メンバーは型が一致するものだけを返す |
| シグネチャヘルプ | 関数・マクロ・組み込み関数・メソッドの引数 |
| インレイヒント | `out` / `inout` 引数に渡している箇所に `out:` / `inout:` を表示 |
| アウトライン | Shader > SubShader > Pass > HLSL 宣言 の階層 |
| Include Tree | エクスプローラーの「ShaderLab Include Tree」に、編集中のファイルを含む root と include 階層を表示 |
| 無効コードのグレーアウト | `#if 0` のように条件がファイル内で確定する分岐をグレーアウト表示 |
| 診断 | 下表を参照 |

### 診断

| 種類 | 重要度 |
| --- | --- |
| 構文エラー(括弧の対応、`ENDHLSL` の欠落、Property の書式、閉じていないコメント/文字列) | エラー |
| `#include` のファイルが見つからない | エラー(`#if` 内は情報) |
| `#pragma vertex` / `fragment` / `kernel` の関数が見つからない | エラー |
| 構造体に存在しないメンバー、不正なスウィズル(`xg` の混在、`float2.z` 等) | エラー |
| 関数・組み込み関数・メソッドの引数の数の不一致(オーバーロード・既定値引数を考慮) | エラー |
| `float2` → `float3` のような暗黙の変換不可 | エラー |
| `float4` → `float3` のような暗黙の切り捨て | 警告 |
| 未定義の識別子・関数・型 | 警告(`#if` 内は情報) |
| Properties にあるが HLSL 側で宣言されていない変数の使用 | 警告 |
| SRP Batcher 非互換(UnityPerMaterial の外で宣言されたプロパティ、パス間で異なる UnityPerMaterial) | 情報 / 警告 |

誤検出を避けるため、次の場合は未定義シンボルの検査を行いません。

- include を解決できないファイルがある(Unity 本体同梱の `UnityCG.cginc` など)
- `.shader` / `.compute` を root としない include 専用ファイル(Include Tree で root を固定すると検査されます)
- マクロ呼び出しの引数の中(トークン連結などで展開結果が分からないため)

## 解析の仕組み

### 翻訳単位と root

HLSL のシンボルは「どのファイルから include されているか」で見え方が変わります。この拡張は次の単位で解析します。

- `.shader` : **パスごと**に、`HLSLPROGRAM` と同じスコープの `HLSLINCLUDE` + その include 先を1つの単位として扱います。
  別パスの `Varyings` や `vert` が混ざることはありません。
- `.hlsl` などの include ファイル : そのファイルを include している **root**(`.shader` 等)の翻訳単位を使います。
  兄弟 include(先に include された `Input.hlsl` で宣言された変数など)も参照できます。

root は自動で選ばれ、Include Tree に「解析中」と表示されます。複数の root がある場合はツリーのピンボタンで固定できます(ワークスペースごとに保存)。

### include の解決

Unity プロジェクトのルート(`Assets` と `ProjectSettings` を持つフォルダ)をファイルの位置から親方向に探すため、
`Assets` 以下だけを開いた場合や、1つのワークスペースに複数のプロジェクトがある場合も解決できます。

- `Packages/<name>/...` : `Packages/` 内の埋め込みパッケージ、`manifest.json` の `file:` 参照、`Library/PackageCache/<name>@<version>`
- `Assets/...` : プロジェクトルートからのパス
- それ以外 : include 元のファイルからの相対パス

URP の主要なマクロ(`CBUFFER_START`、`TEXTURE2D`、`SAMPLER`、`TEXTURE2D_PARAM` / `_ARGS`、`UNITY_VERTEX_INPUT_INSTANCE_ID`、
`DECLARE_LIGHTMAP_OR_SH`、`TEMPLATE_*_FLT`、`#pragma dynamic_branch` など)は宣言として解釈します。
`#include_with_pragmas` にも対応しています。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `URP ShaderLab: 解析rootとして固定` | Include Tree で選択したファイルを解析 root に固定 |
| `URP ShaderLab: 解析rootの固定を解除` | 固定を解除して自動選択に戻す |
| `URP ShaderLab: シェーダーを再解析` | キャッシュを破棄してワークスペースを再走査(パッケージ更新後など) |
| `URP ShaderLab: 解析状況(メモリ)を表示` | 解析済みファイル数やメモリ使用量を Output に表示 |

## 設定

```jsonc
{
  "urpShaderLab.enable": true,
  "urpShaderLab.diagnostics.enable": true,
  "urpShaderLab.diagnostics.undefinedIdentifiers": true,
  "urpShaderLab.diagnostics.srpBatcher": true,
  "urpShaderLab.inlayHints.parameterQualifiers": true,
  "urpShaderLab.trace.server": "off"
}
```

### 色の設定

設定画面で `urpShaderLab.colors` を検索すると、色をプリセットと項目ごとに変更できます(コマンド `URP ShaderLab: 色の設定を開く`)。

| 設定 | 内容 |
| --- | --- |
| `urpShaderLab.colors.preset` | `csharp`(C#風、既定) / `theme`(テーマ標準 = 拡張機能がない場合と同じ色) |
| `urpShaderLab.colors.keyword` など16項目 | キーワード・組み込み型・ユーザー定義の型・関数・組み込み関数・マクロ・ローカル変数・グローバル変数・引数・メンバー・セマンティクス・プリプロセッサ・描画ステート・コメント・文字列・数値。空欄ならプリセットの色 |

色はユーザー設定の `editor.semanticTokenColorCustomizations` と `editor.tokenColorCustomizations` に、
シェーダーの言語(`function:hlsl` など)とスコープだけを対象にしたルールとして書き込まれます。他の言語の色や、ユーザーが追加したルールには影響しません。
拡張機能をアンインストールする前に `URP ShaderLab: 色の設定をすべて削除(テーマ標準に戻す)` を実行すると、書き込んだルールを取り除けます。

## 開発

```sh
npm install
npm run compile   # TypeScript をビルド
npm test          # 解析エンジンの回帰テスト(VS Code 不要)
npm run package   # .vsix を作成
```

VS Code で F5 を押すと拡張機能開発ホストが起動します。

```
src/                 拡張機能本体(Language Client、Include Tree ビュー)
shared/              クライアントとサーバーで共有するリクエスト定義
server/
  server.ts          LSP の接続とリクエストの振り分け
  parser/            字句解析(プリプロセッサ・条件コンパイル)、HLSL / ShaderLab パーサー
  project/           Unity プロジェクトのルート検出、include 解決、include グラフ
  analysis/          ファイルの解析結果、翻訳単位(コンテキスト)、型推論、シンボル解決、組み込み定義
  features/          補完・Hover・定義・参照・診断・セマンティックトークン 等
test/                回帰テストとフィクスチャ(小さな Unity プロジェクト)
syntaxes/            TextMate 文法
```

## 制限事項

- プリプロセッサは完全には評価しません。条件がファイル内で確定する分岐(数値・`true`/`false`・演算、同じファイルで条件の外側に `#define` されたマクロ、`defined()`)だけを無効として扱います。
  Unityのバージョン(`UNITY_VERSION`)、プラットフォーム(`SHADER_API_*`)、`multi_compile` 等のキーワード、include元で上書きできる既定値(`#ifndef X` / `#define X 0`)は判定しません。
  それ以外の分岐は、関数ヘッダだけを切り替える `#if/#else` を除いてすべて解析します。
- `.shader` では、`HLSLPROGRAM` 内の `#define` はそのブロック内の条件にだけ使います(`HLSLINCLUDE` の定義は全パスで共有)。
- マクロの展開は行いません。よく使われる URP のマクロのみ個別に解釈します。

## License

MIT
