import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ALERT_TYPES = ['below', 'above', 'near_stop', 'stop_breach', 'recovery'];
export const ALERT_SCHEDULES = ['realtime', 'daily', 'weekly'];

export const ALERT_TYPE_LABELS = {
  below: 'Price drops below',
  above: 'Price rises above',
  near_stop: 'Within X% of stop-loss',
  stop_breach: 'Stop-loss breached',
  recovery: 'Recovers above stop-loss',
};

export const ALERT_SCHEDULE_LABELS = {
  realtime: 'Real-time',
  daily: 'Daily digest, 17:45',
  weekly: 'Weekly digest, Friday 16:30',
};

function fmt(n) {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : n;
}

export class AlertStore {
  constructor(file) {
    this.file = file;
    this.state = { alerts: [], log: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { alerts: parsed.alerts || [], log: parsed.log || [] };
    } catch {
      this.state = { alerts: [], log: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  add({ symbol, type, value, note, schedule }) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) {
      const e = new Error('symbol is required');
      e.statusCode = 400;
      throw e;
    }
    if (!ALERT_TYPES.includes(type)) {
      const e = new Error(`type must be one of ${ALERT_TYPES.join(', ')}`);
      e.statusCode = 400;
      throw e;
    }
    let val = null;
    if (type !== 'stop_breach' && type !== 'recovery') {
      val = Number(value);
      if (!Number.isFinite(val)) {
        const e = new Error('value must be a number');
        e.statusCode = 400;
        throw e;
      }
    }
    const sched = ALERT_SCHEDULES.includes(schedule) ? schedule : 'realtime';
    const alert = {
      id: crypto.randomUUID(),
      symbol: sym,
      type,
      value: val,
      note: String(note || ''),
      schedule: sched,
      active: true,
      state: 'clear',
      acknowledged: false,
      createdAt: new Date().toISOString(),
      triggeredAt: null,
    };
    this.state.alerts.unshift(alert);
    this.save();
    return alert;
  }

  remove(id) {
    const before = this.state.alerts.length;
    this.state.alerts = this.state.alerts.filter((a) => a.id !== id);
    if (this.state.alerts.length !== before) this.save();
  }

  ack(id) {
    const a = this.state.alerts.find((x) => x.id === id);
    if (a) {
      a.acknowledged = true;
      this.save();
    }
    return a || null;
  }

  async evaluate(quoteOf, snapshotOf) {
    const fired = [];
    for (const a of this.state.alerts) {
      if (!a.active) continue;
      const q = await quoteOf(a.symbol);
      if (!q || q.price == null || !Number.isFinite(q.price)) continue;
      let cond = false;
      let msg = '';
      if (a.type === 'below') {
        cond = q.price <= a.value;
        msg = `${a.symbol} at ${fmt(q.price)} dropped below ${fmt(a.value)}`;
      } else if (a.type === 'above') {
        cond = q.price >= a.value;
        msg = `${a.symbol} at ${fmt(q.price)} rose above ${fmt(a.value)}`;
      } else if (a.type === 'stop_breach' || a.type === 'near_stop' || a.type === 'recovery') {
        const s = await snapshotOf(a.symbol);
        if (!s || s.stop == null) continue;
        if (a.type === 'stop_breach') {
          cond = q.price <= s.stop;
          msg = `${a.symbol} stop-loss breached: ${fmt(q.price)} at or below stop ${fmt(s.stop)}`;
        } else if (a.type === 'recovery') {
          cond = Array.isArray(s.badges) && s.badges.includes('recovered') && (s.dist ?? 0) > 0;
          msg = `${a.symbol} recovered above its stop-loss (distance ${s.dist?.toFixed(2)}%, price ${fmt(q.price)})`;
        } else {
          const d = s.dist;
          if (d == null) continue;
          cond = d <= a.value;
          msg = `${a.symbol} within ${a.value}% of stop-loss (distance ${d.toFixed(2)}%, stop ${fmt(s.stop)}, price ${fmt(q.price)})`;
        }
      }
      if (cond && a.state !== 'triggered') {
        a.state = 'triggered';
        a.triggeredAt = new Date().toISOString();
        a.acknowledged = false;
        const entry = {
          id: crypto.randomUUID(),
          alertId: a.id,
          symbol: a.symbol,
          type: a.type,
          message: msg,
          price: q.price,
          ts: new Date().toISOString(),
        };
        this.state.log.unshift(entry);
        if (this.state.log.length > 200) this.state.log.length = 200;
        fired.push({ alert: a, entry });
      } else if (!cond && a.state === 'triggered') {
        a.state = 'clear';
        a.triggeredAt = null;
      }
    }
    if (fired.length) this.save();
    return fired;
  }
}
