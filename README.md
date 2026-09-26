# 瑞穂の街

**災害の多い日本の国土で、隣町と支え合い競いながら、100 年続く街をつくる。**

Cities: Skylines 2 を目標にした、ブラウザで遊べる 3D の街づくりゲームです。
企画とロードマップは [docs/DESIGN.md](docs/DESIGN.md) にまとめています。

## 遊ぶ

- **公開版**：https://ohta0525.github.io/cities_skyline/
  （リポジトリの Settings → Pages で、Source を「GitHub Actions」にすると公開されます）
- **2D の試作版（v0.1）**：公開版の `prototype/` にあります

PC のブラウザ（Chrome / Edge / Firefox の最新版）で遊んでください。

### 操作

| 操作 | 内容 |
| --- | --- |
| W A S D ／ 矢印 | 移動（Shift で速く） |
| 右ドラッグ | 回転と傾き |
| 中ボタンドラッグ | 地面をつかんで移動 |
| ホイール | ズーム（カーソルの方へ寄る） |
| Q ／ E | 回転 |
| R ／ F | 傾き |
| Home | 初期位置に戻る |
| Space | 一時停止 ／ 再開 |
| 1 ／ 2 ／ 3 | 速度（標準 ／ 2 倍 ／ 4 倍） |

## 今できること（P0：3D 基盤）

- 河川平野と海岸の地形を自動生成（北に山、中央に平野、川が南の湾に注ぐ）
- ジオラマ風の表示：地層の断面、木の台座と真鍮の銘板、ミニチュア効果（周辺のぼかし）
- 森、波の立つ海、川
- Cities: Skylines 風のカメラ操作
- 復興暦の時計（4 月始まり）。1 年の長さは 5 ／ 15 ／ 30 分から選べる
- 保存と読み込み（ブラウザ内、ファイルへの書き出し）、毎月の自動保存
- 画質（高 ／ 中 ／ 低）とミニチュア効果の強さの設定

## 開発

```sh
npm install
npm run dev        # 開発サーバー（http://localhost:5173）
npm test           # テスト
npm run typecheck  # 型チェック
npm run build      # 本番ビルド（dist/）
```

### 構成

| 場所 | 役割 |
| --- | --- |
| `src/world/` | 地形の生成と参照（標高、川、森） |
| `src/sim/` | シミュレーション。Web Worker で描画と別スレッドで動く |
| `src/render/` | Three.js による 3D 表示（地形、水、木、ジオラマ、カメラ、ポストエフェクト） |
| `src/save/` | セーブデータ |
| `src/core/` | 乱数、ノイズ、設定 |
| `tests/` | テスト（Vitest） |

`main` 相当の既定ブランチに push すると、GitHub Actions でテストとビルドを行い、GitHub Pages に公開します。
