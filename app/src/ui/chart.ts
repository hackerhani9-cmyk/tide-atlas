/**
 * Tide curve: a canvas chart of the water level around the current time.
 */
import type {TidePoint} from '../tide/types';
import {fmt} from './i18n';

export interface ChartOptions {
  color: string;
  accent: string;
  grid: string;
  text: string;
}

export class TideChart {
  private ctx: CanvasRenderingContext2D;
  private points: TidePoint[] = [];
  private cursor = 0;
  private opts: ChartOptions;

  constructor(private canvas: HTMLCanvasElement, opts: ChartOptions) {
    this.opts = opts;
    const ctx = canvas.getContext('2d')!;
    this.ctx = ctx;
    const ro = new ResizeObserver(() => this.draw());
    ro.observe(canvas);
  }

  setData(points: TidePoint[]) {
    this.points = points;
    this.draw();
  }

  setCursor(t: number) {
    this.cursor = t;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.points.length < 2) return;

    const padL = 42;
    const padR = 12;
    const padT = 12;
    const padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const t0 = this.points[0].t;
    const t1 = this.points[this.points.length - 1].t;
    let min = Infinity;
    let max = -Infinity;
    for (const p of this.points) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    const span = Math.max(max - min, 0.4);
    min -= span * 0.15;
    max += span * 0.15;

    const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW;
    const Y = (v: number) => padT + (1 - (v - min) / (max - min)) * plotH;

    // grid + y labels
    ctx.strokeStyle = this.opts.grid;
    ctx.fillStyle = this.opts.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = min + ((max - min) * i) / ticks;
      const y = Y(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(v, 1), padL - 6, y);
    }

    // x labels (every 12 h)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1; t += 12 * 3600_000) {
      const x = X(t);
      ctx.strokeStyle = this.opts.grid;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      const d = new Date(t);
      ctx.fillText(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        x,
        h - padB + 4,
      );
    }

    // sea level fill
    ctx.beginPath();
    ctx.moveTo(X(this.points[0].t), Y(min));
    for (const p of this.points) ctx.lineTo(X(p.t), Y(p.v));
    ctx.lineTo(X(this.points[this.points.length - 1].t), Y(min));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, this.opts.color + '55');
    grad.addColorStop(1, this.opts.color + '0d');
    ctx.fillStyle = grad;
    ctx.fill();

    // curve
    ctx.beginPath();
    this.points.forEach((p, i) => {
      const x = X(p.t);
      const y = Y(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = this.opts.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // high / low markers
    for (let i = 1; i < this.points.length - 1; i++) {
      const a = this.points[i - 1].v;
      const b = this.points[i].v;
      const c = this.points[i + 1].v;
      if (!((b > a && b >= c) || (b < a && b <= c))) continue;
      const high = b > a;
      const x = X(this.points[i].t);
      const y = Y(b);
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = high ? this.opts.accent : '#9fb4c8';
      ctx.fill();
      ctx.fillStyle = this.opts.text;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = high ? 'bottom' : 'top';
      ctx.fillText(fmt(b, 2), x, high ? y - 5 : y + 5);
    }

    // cursor
    if (this.cursor >= t0 && this.cursor <= t1) {
      const x = X(this.cursor);
      let cur = 0;
      for (let i = 1; i < this.points.length; i++) {
        if (this.points[i].t >= this.cursor) {
          const f =
            (this.cursor - this.points[i - 1].t) / (this.points[i].t - this.points[i - 1].t || 1);
          cur = this.points[i - 1].v + f * (this.points[i].v - this.points[i - 1].v);
          break;
        }
      }
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      const y = Y(cur);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.strokeStyle = '#0b1622';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
