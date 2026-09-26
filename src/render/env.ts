/**
 * 季節と昼夜をシェーダーに渡す共有の値。
 * 地形・木・建物のマテリアルが同じオブジェクトを参照する。
 */
export const ENV = {
  uSnow: { value: 0 },
  uBlossom: { value: 0 },
  uAutumn: { value: 0 },
  uSummer: { value: 0 },
  /** 0：昼〜1：夜 */
  uNight: { value: 0 },
};

export const ENV_DECL = 'uniform float uSnow;\nuniform float uBlossom;\nuniform float uAutumn;\nuniform float uSummer;\nuniform float uNight;';
