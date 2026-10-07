import { formatTime, normalizeConfig, scheduleAt } from './rest-model.js';
import { IDLE_HINT_MS } from './rest-session.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class RestView {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.actions = new Map();
    this.sequence = 0;
    this.mode = null;
    this.root = element('div', 'c7r-root');
    this.visible = true;
    this.launcher = this.button('休息设置', () => this.callbacks.openSettings(), 'c7r-launcher', 'fxs-activatable');
    this.launcher.textContent = '';
    this.launcherNumbers = element('div', 'c7r-launcher-numbers');
    const metric = iconClass => {
      const row = element('div', 'c7r-metric');
      const icon = element('div', `c7r-icon ${iconClass}`);
      icon.setAttribute('aria-hidden', 'true');
      const value = element('div', 'c7r-metric-value');
      row.appendChild(icon); row.appendChild(value); this.launcherNumbers.appendChild(row);
      return { row, value };
    };
    this.turnMetric = metric('c7r-turn-icon');
    this.separator = element('div', 'c7r-or', '/');
    this.launcherNumbers.appendChild(this.separator);
    this.timeMetric = metric('c7r-time-icon');
    this.offLabel = element('div', 'c7r-off-label', '已关闭');
    this.launcherNumbers.appendChild(this.offLabel);
    this.idleHint = element('div', 'c7r-idle-hint');
    this.launcher.appendChild(this.launcherNumbers);
    this.launcher.appendChild(this.idleHint);
    this.root.appendChild(this.launcher);
    document.body.appendChild(this.root);
    this.mountLauncher();
  }

  mountLauncher() {
    // Participate in the original bar's flex layout. Never float over its buttons.
    const bar = document.querySelector('panel-system-bar');
    if (bar && this.launcher.parentElement !== bar) bar.appendChild(this.launcher);
    this.launcher.style.display = bar && this.visible && !this.mode ? '' : 'none';
  }

  setVisible(visible) {
    this.visible = visible;
    this.root.style.display = visible ? '' : 'none';
    this.mountLauncher();
  }

  button(label, onActivate, className = '', tag = 'fxs-button') {
    const button = element(tag, `c7r-button ${className}`);
    if (tag === 'fxs-button') button.setAttribute('caption', label);
    const id = String(++this.sequence);
    button.setAttribute('data-c7r-action', id);
    button.setAttribute('tabindex', '0');
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', label);
    this.actions.set(id, onActivate);
    // A native click also produces action-activate and DOM click notifications.
    // Modal controls are dispatched once by RestController's engine-input guard.
    // Only the HUD launcher uses the ordinary component activation path.
    button.addEventListener('action-activate', () => {
      if (!this.modal) this.activate(button);
    });
    return button;
  }

  activate(target) {
    const button = target?.closest?.('[data-c7r-action]');
    if (!button || (!this.root.contains(button) && button !== this.launcher) || button.getAttribute('disabled') === 'true') return;
    if (this.modal && !this.modal.contains(button)) return;
    this.actions.get(button.getAttribute('data-c7r-action'))?.();
  }

  open(mode) {
    this.close();
    this.mode = mode;
    this.modal = element('div', 'c7r-overlay');
    this.modal.setAttribute('role', 'dialog');
    this.modal.setAttribute('aria-modal', 'true');
    this.card = element('fxs-frame', `c7r-card c7r-card-${mode}`);
    this.card.setAttribute('frame-style', 'f1');
    this.card.setAttribute('override-styling', 'relative flex flex-col pointer-events-auto');
    this.card.setAttribute('content-class', 'c7r-card-content');
    this.card.setAttribute('filigree-class', 'mt-3');
    this.modal.appendChild(this.card);
    this.root.appendChild(this.modal);
    this.launcher.style.display = 'none';
  }

  close() {
    if (this.modal) {
      this.modal.querySelectorAll('[data-c7r-action]').forEach(node =>
        this.actions.delete(node.getAttribute('data-c7r-action')));
      this.modal.remove();
    }
    this.modal = null;
    this.mode = null;
    this.mountLauncher();
    this.preview = null;
  }

  title(text) {
    const title = element('fxs-header', 'c7r-title font-title text-xl');
    title.setAttribute('title', text);
    title.setAttribute('filigree-style', 'h2');
    this.card.appendChild(title);
  }

  showRest(pending) {
    if (this.mode === 'rest') return;
    this.open('rest');
    this.modal.setAttribute('aria-label', '强制休息倒计时');
    this.title('强制休息');
    const reason = pending.reason === 'time' ? '连续游戏时间已到' : `第 ${pending.turn} 回合结束`;
    this.card.appendChild(element('p', 'c7r-subtitle', `${reason} · 休息 ${pending.durationMs / 60000} 分钟`));
    this.timer = element('div', 'c7r-timer', formatTime(pending.durationMs));
    this.timer.setAttribute('role', 'timer');
    this.card.appendChild(this.timer);
    const track = element('div', 'c7r-track');
    this.progress = element('div', 'c7r-progress');
    track.appendChild(this.progress);
    this.card.appendChild(track);
    this.message = element('p', 'c7r-tip', '起身走一走，喝口水，看看远处。');
    this.card.appendChild(this.message);
    this.continueButton = this.button('休息中，请稍候', () => this.callbacks.resume(), 'c7r-primary c7r-continue');
    this.continueButton.setAttribute('disabled', 'true');
    this.card.appendChild(this.continueButton);
    this.card.appendChild(element('p', 'c7r-footnote', '倒计时结束前无法关闭。切换到其他窗口，休息计时仍会继续。'));
  }

  updateRest(remaining, duration) {
    if (this.mode !== 'rest') return;
    this.timer.textContent = formatTime(remaining);
    this.progress.style.width = `${Math.min(100, Math.max(0, (1 - remaining / duration) * 100))}%`;
    const ready = remaining <= 0;
    this.continueButton.setAttribute('disabled', String(!ready));
    this.continueButton.setAttribute('caption', ready ? '休息完成，继续' : '休息中，请稍候');
    this.message.textContent = ready ? '休息结束。继续后，回合与时间间隔一同重新计算。' : '起身走一走，喝口水，看看远处。';
  }

  showSettings(config, turn) {
    this.open('settings');
    this.draft = normalizeConfig(config);
    this.modal.setAttribute('aria-label', '休息设置');
    this.title('休息设置');
    this.card.appendChild(element('p', 'c7r-subtitle', '两种功能独立开启 · 任意一次休息后共同重置'));
    const fields = element('div', 'c7r-fields');
    this.card.appendChild(fields);
    this.addStepper(fields, '每次休息', () => this.draft.restMinutes,
      v => { this.draft.restMinutes = v; }, 0.1, 120, 0.5, '分钟');
    this.addToggle(fields, '按回合休息', 'turnEnabled');
    ['1–20 回合', '21–40 回合', '41–60 回合', '61–80 回合', '80 回合之后'].forEach((label, i) => {
      this.addStepper(fields, label, () => this.draft.intervals[i],
        v => { this.draft.intervals[i] = v; }, 1, 100, 1, '回合一休');
    });
    this.addToggle(fields, '按时间休息', 'timeEnabled');
    this.addStepper(fields, '连续游戏', () => this.draft.playMinutes,
      v => { this.draft.playMinutes = v; }, 1, 240, 1, '分钟后休息');
    this.preview = element('p', 'c7r-preview');
    this.card.appendChild(this.preview);
    this.previewTurn = turn;
    this.updatePreview();
    this.notice = element('p', 'c7r-footnote', '每20回合一档固定。读档时间计入游戏时间；无操作1分钟显示已休息时长，满5分钟算休息一次。退出游戏清除本次计时。');
    this.card.appendChild(this.notice);
    const footer = element('div', 'c7r-footer');
    footer.appendChild(this.button('恢复默认', () => this.showSettings(normalizeConfig(), turn)));
    footer.appendChild(this.button('取消', () => this.callbacks.closeSettings()));
    footer.appendChild(this.button('保存设置', () => this.callbacks.saveSettings(this.draft), 'c7r-primary'));
    this.card.appendChild(footer);
  }

  addStepper(parent, label, get, set, min, max, step, unit) {
    const row = element('div', 'c7r-row');
    row.appendChild(element('div', 'c7r-label', label));
    const controls = element('div', 'c7r-stepper');
    const value = element('div', 'c7r-value');
    const refresh = () => { value.textContent = `${get()} ${unit}`; };
    const change = delta => {
      let next = get() + delta;
      // The 0.1-minute minimum is useful for checking the overlay in game.
      if (step === 0.5 && get() === 0.1 && delta > 0) next = 0.5;
      set(Math.round(Math.max(min, Math.min(max, next)) * 10) / 10);
      refresh();
      this.updatePreview();
    };
    const minus = this.button('−', () => change(-step), 'c7r-step');
    const plus = this.button('+', () => change(step), 'c7r-step');
    minus.setAttribute('aria-label', `减少${label}`);
    plus.setAttribute('aria-label', `增加${label}`);
    controls.appendChild(minus);
    controls.appendChild(value);
    controls.appendChild(plus);
    row.appendChild(controls);
    parent.appendChild(row);
    refresh();
  }

  addToggle(parent, label, key) {
    const row = element('div', 'c7r-row');
    row.appendChild(element('div', 'c7r-label', label));
    const refresh = () => {
      toggle.setAttribute('selected', String(this.draft[key]));
      toggle.setAttribute('aria-checked', String(this.draft[key]));
    };
    const toggle = this.button('', () => {
      this.draft[key] = !this.draft[key]; refresh(); this.updatePreview();
    }, 'c7r-toggle', 'fxs-switch');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('role', 'switch');
    refresh(); row.appendChild(toggle); parent.appendChild(row);
  }

  updatePreview() {
    if (!this.preview) return;
    const current = scheduleAt(this.previewTurn, this.draft);
    const turns = this.draft.turnEnabled ? `每 ${current.interval} 回合` : '';
    const time = this.draft.timeEnabled ? `连续游戏 ${this.draft.playMinutes} 分钟` : '';
    this.preview.textContent = turns || time ? `${[turns, time].filter(Boolean).join(' 或 ')}触发休息 ${this.draft.restMinutes} 分钟。` : '两项均已关闭。';
  }

  updateLauncher(current, config, error, session, now) {
    this.mountLauncher();
    const turns = Math.max(0, session.targetTurn(current, config) - current.turn);
    const remaining = Math.max(0, config.playMinutes * 60000 - session.elapsed(now));
    this.turnMetric.row.style.display = config.turnEnabled ? '' : 'none';
    this.timeMetric.row.style.display = config.timeEnabled ? '' : 'none';
    this.separator.style.display = config.turnEnabled && config.timeEnabled ? '' : 'none';
    this.offLabel.style.display = config.turnEnabled || config.timeEnabled ? 'none' : '';
    this.turnMetric.value.textContent = String(turns);
    this.timeMetric.value.textContent = formatTime(remaining);
    const idle = config.timeEnabled ? session.idle(now) : 0;
    // Idle text replaces the metrics in the same single row, above the leader HUD.
    this.launcherNumbers.style.display = idle >= IDLE_HINT_MS ? 'none' : '';
    this.idleHint.style.display = idle >= IDLE_HINT_MS ? '' : 'none';
    this.idleHint.textContent = `已休息 ${Math.floor(idle / 60000)} 分 ${Math.floor(idle / 1000) % 60} 秒`;
    const secondsRemaining = Math.ceil(remaining / 1000);
    const until = [config.turnEnabled ? `${turns} 回合` : '',
      config.timeEnabled ? `${Math.floor(secondsRemaining / 60)} 分 ${secondsRemaining % 60} 秒` : ''].filter(Boolean);
    let tooltip = until.length ? `还有 ${until.join(' 或 ')}强制休息 ${config.restMinutes} 分钟。` : '按回合休息和按时间休息均已关闭。';
    if (config.turnEnabled && turns === 0) tooltip += '本回合结束时触发。';
    if (idle >= IDLE_HINT_MS) tooltip += this.idleHint.textContent + (session.idleRested ? '；已完成一次休息。' : '；满5分钟算休息一次。');
    tooltip += '点击打开休息设置。';
    if (error) tooltip += '设置保存异常。';
    this.launcher.setAttribute('data-tooltip-content', tooltip);
    this.launcher.setAttribute('aria-label', tooltip);
  }

  destroy() { this.actions.clear(); this.launcher.remove(); this.root.remove(); }
}
