// 游戏内“休息设置”优先于这些初始值。修改文件后需重新载入游戏。
export const DEFAULTS = Object.freeze({
  turnEnabled: true,
  timeEnabled: true,
  playMinutes: 25,
  restMinutes: 5,
  intervals: Object.freeze([5, 4, 3, 2, 1]),
});
