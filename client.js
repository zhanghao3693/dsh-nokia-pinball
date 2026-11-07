/* ============================================================================
 * dsh-nokia-pinball — client half
 *
 * 复刻 2007–2009 年诺基亚手机上的弹珠台（Pinball）：竖屏台面、重力钢珠、
 * 左右弹片、缓冲器、靶子、滚道、发射蓄力、掉球失命、三球制、高分榜。
 *
 * 硬约束（踩过的坑，别改）：
 *  - 本文件只能被 exports["./client"] 加载，顶层不得引用 Node API；
 *    React 只能从 factory 的 require 拿。
 *  - index.js 是服务端空壳，这里全部逻辑跑在浏览器侧。
 *  - 物理内核（createGame / step / launchBall）是纯数据函数，不碰 DOM，
 *    便于在 Node vm 沙箱里做无头回归。
 * ========================================================================== */

window.__ModuleLoader__.load({
  id: "dsh-nokia-pinball",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    const { useState, useRef, useEffect } = React;

    /* ------------------------------------------------------------------ 常量 */

    const NS = "nokia-pinball";
    const HI_KEY = "dsh.nokia-pinball.hi.v1";

    const W = 360;
    const H = 640;
    const BALL_R = 7.5;
    const GRAVITY = 1050;
    const MAX_SPEED = 1500;
    const DRAG = 0.9994;

    const FLIP_LEN = 58;
    const PIV_L = { x: 92, y: 556 };
    const PIV_R = { x: 226, y: 556 };
    const L_REST = 0.42;
    const L_ACTIVE = -0.46;
    const R_REST = Math.PI - 0.42;
    const R_ACTIVE = Math.PI + 0.46;
    const FLIP_SPEED = 17;

    /* 台面边界：线段 [x1,y1,x2,y2,restitution]
       x 12..306 是主台面，x 310..348 是右侧发射槽。
       顶部 (306,44)-(348,96) 是斜导流板：钢珠从发射槽直冲上去后被
       反射到左上，越过 x=310 的隔墙顶端（y=96）进入主台面。 */
    const WALLS = [
      [12, 44, 306, 44, 0.72],
      [306, 44, 348, 96, 0.72],
      [348, 96, 348, 610, 0.72],
      [310, 96, 310, 610, 0.72],
      [12, 44, 12, 510, 0.72],
      [12, 510, 60, 586, 0.72],
      [60, 586, 60, 620, 0.72],
      [306, 510, 258, 586, 0.72],
      [258, 586, 258, 620, 0.72],
    ];

    /* 弹片上方两块弹射胶 */
    const SLINGS = [
      [44, 466, 92, 528, 1.06, 150],
      [274, 466, 226, 528, 1.06, 150],
    ];

    const BUMPERS = [
      { x: 90, y: 215, r: 22, e: 1.38, kick: 230, score: 100 },
      { x: 159, y: 178, r: 22, e: 1.38, kick: 230, score: 100 },
      { x: 228, y: 215, r: 22, e: 1.38, kick: 230, score: 100 },
    ];

    const TARGETS = [
      { x: 70, y: 330, r: 10 },
      { x: 114, y: 330, r: 10 },
      { x: 159, y: 330, r: 10 },
      { x: 204, y: 330, r: 10 },
      { x: 248, y: 330, r: 10 },
    ];

    const ROLLOVERS = [
      { x: 80, y: 104, r: 9 },
      { x: 159, y: 104, r: 9 },
      { x: 238, y: 104, r: 9 },
    ];

    const COLORS = {
      bg: "#0a1419",
      grid: "rgba(79,209,197,.045)",
      steel: "#3d6d72",
      steelHi: "#6fb3ad",
      amber: "#e8b64a",
      amberDim: "#6b5420",
      lit: "#ffd873",
      ball: "#f2f6f5",
      text: "#8fd8cf",
      danger: "#e8705a",
    };

    /* ------------------------------------------------------------ 存档 */

    function loadHi() {
      try {
        const v = Number(window.localStorage.getItem(HI_KEY));
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
      } catch {
        return 0;
      }
    }

    function saveHi(v) {
      try {
        window.localStorage.setItem(HI_KEY, String(Math.floor(v)));
      } catch {
        /* 隐私模式下写不进，忽略 */
      }
    }

    function pad(n, len) {
      return String(Math.max(0, Math.floor(n))).padStart(len, "0");
    }

    /* ------------------------------------------------------------ 物理内核 */

    function createGame(hi) {
      return {
        phase: "ready", /* ready | playing | over */
        score: 0,
        hi: Number.isFinite(hi) ? hi : 0,
        balls: 3,
        ball: null,
        flippers: {
          l: { angle: L_REST, omega: 0 },
          r: { angle: R_REST, omega: 0 },
        },
        plunger: { held: false, charge: 0 },
        targets: [false, false, false, false, false],
        rollovers: [false, false, false],
        bumperCd: [0, 0, 0],
        targetCd: [0, 0, 0, 0, 0],
        flipCd: 0,
        bumpFlash: [0, 0, 0],
        combo: 0,
        comboT: 0,
        mult: 1,
        msg: "按空格 / 点「发射」蓄力开球",
        msgT: 3.2,
        pops: [],
        cues: [],
        tick: 0,
      };
    }

    function restartGame(s) {
      const hi = s.hi;
      const fresh = createGame(hi);
      Object.keys(fresh).forEach((k) => {
        s[k] = fresh[k];
      });
    }

    function launchBall(s, power) {
      if (s.phase !== "ready" || s.ball) return false;
      const p = Math.max(0, Math.min(1, power));
      /* 基础速度必须足够越过发射槽隔墙顶端 (y=96)：
         从 y=574 冲到 y<96 需 v>sqrt(2*g*478)≈1002。
         880+520*p 让 p>0.23（约按住 0.26 秒）即可入场，
         轻点一下则球弹回发射槽，可重新蓄力，不判失球。 */
      s.ball = {
        x: 329,
        y: 574,
        vx: 0,
        vy: -(880 + 520 * p),
        r: BALL_R,
      };
      s.phase = "playing";
      s.plunger.held = false;
      s.plunger.charge = 0;
      s.msg = "";
      s.msgT = 0;
      s.cues.push("launch");
      return true;
    }

    function flipperSegment(side, angle) {
      const piv = side === "l" ? PIV_L : PIV_R;
      return [
        piv.x,
        piv.y,
        piv.x + Math.cos(angle) * FLIP_LEN,
        piv.y + Math.sin(angle) * FLIP_LEN,
      ];
    }

    function closestOnSegment(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      return { x: x1 + t * dx, y: y1 + t * dy };
    }

    /* 圆 vs 线段。sv 是该点的表面速度（弹片用），传 null 表示静止墙。 */
    function collideSegment(b, x1, y1, x2, y2, e, kick, sv) {
      const c = closestOnSegment(b.x, b.y, x1, y1, x2, y2);
      let dx = b.x - c.x;
      let dy = b.y - c.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d >= b.r) return null;
      if (d < 0.0001) {
        /* 球心正好压在线上：用线段法线把它推开 */
        const sx = x2 - x1;
        const sy = y2 - y1;
        const sl = Math.sqrt(sx * sx + sy * sy) || 1;
        dx = -sy / sl;
        dy = sx / sl;
        d = 0.0001;
      }
      const nx = dx / d;
      const ny = dy / d;
      b.x = c.x + nx * (b.r + 0.25);
      b.y = c.y + ny * (b.r + 0.25);

      let ux = b.vx - (sv ? sv.x : 0);
      let uy = b.vy - (sv ? sv.y : 0);
      const un = ux * nx + uy * ny;
      if (un < 0) {
        const j = -(1 + e) * un;
        ux += j * nx;
        uy += j * ny;
        b.vx = ux + (sv ? sv.x : 0);
        b.vy = uy + (sv ? sv.y : 0);
      }
      if (kick) {
        b.vx += nx * kick;
        b.vy += ny * kick;
      }
      return { nx, ny };
    }

    function collideCircle(b, c, e, kick) {
      let dx = b.x - c.x;
      let dy = b.y - c.y;
      const rr = b.r + c.r;
      let d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) return null;
      let d = Math.sqrt(d2);
      if (d < 0.0001) {
        dx = 0;
        dy = -1;
        d = 0.0001;
      }
      const nx = dx / d;
      const ny = dy / d;
      b.x = c.x + nx * (rr + 0.25);
      b.y = c.y + ny * (rr + 0.25);
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        const j = -(1 + e) * vn;
        b.vx += j * nx;
        b.vy += j * ny;
      }
      if (kick) {
        b.vx += nx * kick;
        b.vy += ny * kick;
      }
      return { nx, ny };
    }

    function clampSpeed(b) {
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > MAX_SPEED) {
        const k = MAX_SPEED / sp;
        b.vx *= k;
        b.vy *= k;
      }
    }

    function addScore(s, n, x, y, label) {
      const gain = Math.round(n * s.mult);
      s.score += gain;
      if (s.score > s.hi) s.hi = s.score;
      s.pops.push({ x, y, text: "+" + gain, t: 0.9 });
      if (label) s.msg = label;
      if (s.pops.length > 14) s.pops.shift();
    }

    function bumpCombo(s) {
      s.combo += 1;
      s.comboT = 1.5;
      s.mult = Math.min(5, 1 + Math.floor(s.combo / 3));
    }

    function step(s, dt, input) {
      const D = Math.max(0.0001, Math.min(0.05, dt));
      s.tick += D;

      /* 发射槽蓄力 */
      if (s.plunger.held) {
        s.plunger.charge = Math.min(1.15, s.plunger.charge + D);
      }

      /* 弹片角度：朝目标匀速转，角速度喂给碰撞做表面速度 */
      const fl = s.flippers.l;
      const fr = s.flippers.r;
      const move = (a, target) => {
        const diff = target - a;
        const maxStep = FLIP_SPEED * D;
        if (Math.abs(diff) <= maxStep) return target;
        return a + Math.sign(diff) * maxStep;
      };
      const naL = move(fl.angle, input.left ? L_ACTIVE : L_REST);
      const naR = move(fr.angle, input.right ? R_ACTIVE : R_REST);
      fl.omega = (naL - fl.angle) / D;
      fr.omega = (naR - fr.angle) / D;
      fl.angle = naL;
      fr.angle = naR;

      /* 计时器 */
      for (let i = 0; i < 3; i++) {
        s.bumperCd[i] = Math.max(0, s.bumperCd[i] - D);
        s.bumpFlash[i] = Math.max(0, s.bumpFlash[i] - D);
      }
      for (let i = 0; i < 5; i++) s.targetCd[i] = Math.max(0, s.targetCd[i] - D);
      s.flipCd = Math.max(0, s.flipCd - D);
      s.comboT = Math.max(0, s.comboT - D);
      if (s.comboT === 0 && s.combo !== 0) {
        s.combo = 0;
        s.mult = 1;
      }
      s.msgT = Math.max(0, s.msgT - D);
      if (s.msgT === 0 && s.msg) s.msg = "";
      for (let i = s.pops.length - 1; i >= 0; i--) {
        s.pops[i].t -= D;
        if (s.pops[i].t <= 0) s.pops.splice(i, 1);
      }

      if (s.phase !== "playing" || !s.ball) return;

      const b = s.ball;
      const N = 3;
      const sub = D / N;
      const segL = flipperSegment("l", fl.angle);
      const segR = flipperSegment("r", fr.angle);

      for (let k = 0; k < N; k++) {
        b.vy += GRAVITY * sub;
        b.vx *= DRAG;
        b.vy *= DRAG;
        clampSpeed(b);
        b.x += b.vx * sub;
        b.y += b.vy * sub;

        /* 固定墙 */
        for (let i = 0; i < WALLS.length; i++) {
          const w = WALLS[i];
          collideSegment(b, w[0], w[1], w[2], w[3], w[4], 0, null);
        }

        /* 弹射胶 */
        for (let i = 0; i < SLINGS.length; i++) {
          const sl = SLINGS[i];
          const hit = collideSegment(b, sl[0], sl[1], sl[2], sl[3], sl[4], 0, null);
          if (hit) {
            b.vx += hit.nx * sl[5];
            b.vy += hit.ny * sl[5];
            addScore(s, 30, b.x, b.y, "");
            s.cues.push("sling");
          }
        }

        /* 弹片：把角速度换成接触点的表面速度 */
        const flippers = [
          { seg: segL, piv: PIV_L, omega: fl.omega },
          { seg: segR, piv: PIV_R, omega: fr.omega },
        ];
        for (let i = 0; i < flippers.length; i++) {
          const f = flippers[i];
          const c = closestOnSegment(b.x, b.y, f.seg[0], f.seg[1], f.seg[2], f.seg[3]);
          const rx = c.x - f.piv.x;
          const ry = c.y - f.piv.y;
          const sv = { x: -f.omega * ry, y: f.omega * rx };
          const hit = collideSegment(b, f.seg[0], f.seg[1], f.seg[2], f.seg[3], 0.46, 0, sv);
          if (hit && s.flipCd === 0) {
            s.cues.push("flip");
            s.flipCd = 0.07;
          }
        }

        /* 缓冲器 */
        for (let i = 0; i < BUMPERS.length; i++) {
          const bp = BUMPERS[i];
          const hit = collideCircle(b, bp, bp.e, bp.kick);
          if (hit && s.bumperCd[i] === 0) {
            s.bumperCd[i] = 0.11;
            s.bumpFlash[i] = 0.18;
            bumpCombo(s);
            addScore(s, bp.score, bp.x, bp.y - bp.r - 6, "");
            s.cues.push("bumper");
          }
        }

        /* 靶子 */
        for (let i = 0; i < TARGETS.length; i++) {
          const tg = TARGETS[i];
          const hit = collideCircle(b, tg, 0.86, 0);
          if (hit && !s.targets[i] && s.targetCd[i] === 0) {
            s.targetCd[i] = 0.16;
            s.targets[i] = true;
            addScore(s, 250, tg.x, tg.y - 14, "");
            s.cues.push("target");
            if (s.targets.every(Boolean)) {
              addScore(s, 2000, 159, 300, "全靶命中 +2000");
              s.msgT = 2.2;
              s.targets = [false, false, false, false, false];
              s.cues.push("bonus");
            }
          }
        }

        /* 顶部滚道 */
        for (let i = 0; i < ROLLOVERS.length; i++) {
          const ro = ROLLOVERS[i];
          const dx = b.x - ro.x;
          const dy = b.y - ro.y;
          if (dx * dx + dy * dy < (ro.r + b.r) * (ro.r + b.r) && !s.rollovers[i]) {
            s.rollovers[i] = true;
            addScore(s, 150, ro.x, ro.y - 12, "");
            s.cues.push("roll");
            if (s.rollovers.every(Boolean)) {
              addScore(s, 1000, 159, 120, "滚道全亮 +1000");
              s.msgT = 2.2;
              s.rollovers = [false, false, false];
              s.cues.push("bonus");
            }
          }
        }

        clampSpeed(b);

        /* 回到发射槽（不算失球） */
        if (b.y > 600 && b.x > 308) {
          s.ball = null;
          s.phase = "ready";
          s.plunger.charge = 0;
          s.msg = "球回到发射槽 · 再发一次";
          s.msgT = 2.4;
          s.cues.push("return");
          return;
        }

        /* 掉球 */
        if (b.y > 636) {
          s.ball = null;
          s.balls -= 1;
          s.cues.push("drain");
          if (s.balls <= 0) {
            s.balls = 0;
            s.phase = "over";
            s.msg = "";
          } else {
            s.phase = "ready";
            s.combo = 0;
            s.mult = 1;
            s.msg = "失一球 · 按空格发射";
            s.msgT = 2.4;
          }
          return;
        }
      }
    }

    /* ------------------------------------------------------------ 绘制 */

    function line(ctx, x1, y1, x2, y2, color, width) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineCap = "round";
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    function disc(ctx, x, y, r, fill, stroke, sw) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.lineWidth = sw || 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    }

    function draw(ctx, s) {
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, W, H);

      /* 底色 + 诺基亚 LCD 风格细格 */
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      for (let x = 0; x <= W; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y <= H; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      /* 顶部 LCD 条 */
      ctx.fillStyle = "rgba(79,209,197,.07)";
      ctx.fillRect(0, 0, W, 38);
      ctx.fillStyle = COLORS.text;
      ctx.font = 'bold 12px "Courier New",monospace';
      ctx.textBaseline = "middle";
      ctx.fillText("NOKIA", 12, 19);
      ctx.font = 'bold 15px "Courier New",monospace';
      ctx.textAlign = "right";
      ctx.fillStyle = COLORS.lit;
      ctx.fillText(pad(s.score, 7), 348, 19);
      ctx.textAlign = "left";
      ctx.font = 'bold 11px "Courier New",monospace';
      ctx.fillStyle = COLORS.text;
      let dots = "";
      for (let i = 0; i < 3; i++) dots += i < s.balls ? "●" : "○";
      ctx.fillText(dots, 116, 19);
      if (s.mult > 1) {
        ctx.fillStyle = COLORS.amber;
        ctx.fillText("×" + s.mult, 176, 19);
      }

      /* 台面边界 */
      for (let i = 0; i < WALLS.length; i++) {
        const w = WALLS[i];
        line(ctx, w[0], w[1], w[2], w[3], COLORS.steel, 7);
        line(ctx, w[0], w[1], w[2], w[3], COLORS.steelHi, 2);
      }

      /* 弹射胶 */
      for (let i = 0; i < SLINGS.length; i++) {
        const sl = SLINGS[i];
        line(ctx, sl[0], sl[1], sl[2], sl[3], COLORS.amberDim, 9);
        line(ctx, sl[0], sl[1], sl[2], sl[3], COLORS.amber, 3);
      }

      /* 滚道 */
      for (let i = 0; i < ROLLOVERS.length; i++) {
        const ro = ROLLOVERS[i];
        disc(ctx, ro.x, ro.y, ro.r + 3, "rgba(79,209,197,.10)", COLORS.steel, 1.5);
        if (s.rollovers[i]) disc(ctx, ro.x, ro.y, ro.r - 2, COLORS.lit, null, 0);
        else disc(ctx, ro.x, ro.y, ro.r - 2, "#122a30", COLORS.steelHi, 1);
      }

      /* 靶子 */
      for (let i = 0; i < TARGETS.length; i++) {
        const tg = TARGETS[i];
        disc(ctx, tg.x, tg.y, tg.r + 3, "#0e2228", COLORS.steel, 1.5);
        if (s.targets[i]) {
          disc(ctx, tg.x, tg.y, tg.r - 1, COLORS.lit, COLORS.amber, 2);
        } else {
          disc(ctx, tg.x, tg.y, tg.r - 1, "#1b3a40", COLORS.steelHi, 1.5);
        }
      }

      /* 缓冲器 */
      for (let i = 0; i < BUMPERS.length; i++) {
        const bp = BUMPERS[i];
        const flash = s.bumpFlash[i] > 0;
        disc(ctx, bp.x, bp.y, bp.r + 5, "#0d252b", COLORS.steel, 2);
        disc(ctx, bp.x, bp.y, bp.r, flash ? COLORS.lit : "#1c4148", flash ? "#fff2c0" : COLORS.steelHi, 2.5);
        disc(ctx, bp.x, bp.y, bp.r - 8, flash ? "#fff6d8" : "#16333a", null, 0);
        ctx.fillStyle = flash ? "#4a3a10" : COLORS.text;
        ctx.font = 'bold 11px "Courier New",monospace';
        ctx.textAlign = "center";
        ctx.fillText(String(100), bp.x, bp.y + 4);
        ctx.textAlign = "left";
      }

      /* 翻板 */
      const segL = flipperSegment("l", s.flippers.l.angle);
      const segR = flipperSegment("r", s.flippers.r.angle);
      [segL, segR].forEach((sg) => {
        line(ctx, sg[0], sg[1], sg[2], sg[3], "#5a4415", 15);
        line(ctx, sg[0], sg[1], sg[2], sg[3], COLORS.amber, 9);
        line(ctx, sg[0], sg[1], sg[2], sg[3], COLORS.lit, 2);
        disc(ctx, sg[0], sg[1], 5, COLORS.steelHi, null, 0);
      });

      /* 发射槽蓄力条 */
      const ch = Math.min(1, s.plunger.charge / 1.15);
      ctx.fillStyle = "#0d252b";
      ctx.fillRect(314, 566, 30, 44);
      ctx.fillStyle = COLORS.amber;
      ctx.fillRect(317, 606 - 36 * ch, 24, 36 * ch);
      ctx.strokeStyle = COLORS.steel;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(314, 566, 30, 44);

      /* 钢珠 */
      if (s.ball) {
        const b = s.ball;
        disc(ctx, b.x + 1.5, b.y + 2, b.r + 1, "rgba(0,0,0,.45)", null, 0);
        disc(ctx, b.x, b.y, b.r, COLORS.ball, "#9fb8b6", 1.5);
        disc(ctx, b.x - 2.2, b.y - 2.5, 2.2, "#ffffff", null, 0);
      }

      /* 飘分 */
      ctx.textAlign = "center";
      ctx.font = 'bold 13px "Courier New",monospace';
      for (let i = 0; i < s.pops.length; i++) {
        const p = s.pops[i];
        ctx.globalAlpha = Math.min(1, p.t / 0.5);
        ctx.fillStyle = COLORS.lit;
        ctx.fillText(p.text, p.x, p.y - (0.9 - p.t) * 22);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";

      /* 中央提示 */
      if (s.msg) {
        ctx.fillStyle = "rgba(6,16,20,.82)";
        ctx.fillRect(24, 286, 312, 50);
        ctx.strokeStyle = COLORS.steel;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(24, 286, 312, 50);
        ctx.fillStyle = COLORS.text;
        ctx.font = 'bold 13px "Courier New",monospace';
        ctx.textAlign = "center";
        ctx.fillText(s.msg, 180, 311);
        ctx.textAlign = "left";
      }

      /* 结束遮罩由 React DOM 层负责，画布只压暗 */
      if (s.phase === "over") {
        ctx.fillStyle = "rgba(4,10,13,.55)";
        ctx.fillRect(0, 38, W, H - 38);
      }
    }

    /* ------------------------------------------------------------ 音效 */

    function beep(ac, freq, dur, type, vol, slide) {
      if (!ac) return;
      try {
        const t0 = ac.currentTime;
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = type || "square";
        osc.frequency.setValueAtTime(freq, t0);
        if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(60, slide), t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol || 0.06, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch {
        /* 音频被浏览器策略拦下就静音继续 */
      }
    }

    function ensureAudio(audioRef) {
      if (audioRef.current) return audioRef.current;
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        audioRef.current = new Ctor();
      } catch {
        audioRef.current = null;
      }
      return audioRef.current;
    }

    function playCues(cues, audioRef, on) {
      if (!on || !cues.length) return;
      const ac = ensureAudio(audioRef);
      for (let i = 0; i < cues.length; i++) {
        switch (cues[i]) {
          case "launch": beep(ac, 220, 0.22, "square", 0.07, 620); break;
          case "bumper": beep(ac, 520 + Math.random() * 120, 0.07, "square", 0.055); break;
          case "target": beep(ac, 760, 0.09, "square", 0.05); break;
          case "roll": beep(ac, 880, 0.08, "triangle", 0.05); break;
          case "sling": beep(ac, 300, 0.06, "square", 0.045); break;
          case "flip": beep(ac, 170, 0.045, "square", 0.035); break;
          case "bonus": beep(ac, 660, 0.22, "square", 0.06, 1320); break;
          case "return": beep(ac, 420, 0.12, "triangle", 0.045, 260); break;
          case "drain": beep(ac, 340, 0.35, "sawtooth", 0.06, 90); break;
          default: break;
        }
      }
    }

    /* ------------------------------------------------------------ CSS */

    const CSS = `
.np-root{position:fixed;inset:0;pointer-events:none;z-index:2147483001;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --np-accent:#4fd1c5;--np-amber:#e8b64a;--np-line:rgba(128,128,128,.35);
  --np-bg:var(--dsw-alias-bg-layer-1,#1b2226);--np-bg2:var(--dsw-alias-bg-layer-3,#12191d);
  --np-fg:var(--dsw-alias-label-primary,#e8e8ea);--np-fg2:var(--dsw-alias-label-secondary,#a8adb5);
  --np-fg3:var(--dsw-alias-label-tertiary,#8b8f98)}
body:not([data-ds-dark-theme]) .np-root{--np-accent:#0e7c73;--np-amber:#8a6512;--np-line:rgba(0,0,0,.18);
  --np-bg:#f4f6f5;--np-bg2:#e6ecea;--np-fg:#1a2426;--np-fg2:#4a5658;--np-fg3:#6b7779}
.np-fab{position:absolute;right:18px;bottom:148px;pointer-events:auto;display:flex;align-items:center;gap:7px;
  padding:9px 14px 9px 11px;border-radius:999px;cursor:pointer;border:1px solid var(--np-line);
  background:var(--np-bg);color:var(--np-fg);box-shadow:0 6px 20px rgba(0,0,0,.28);
  font-size:13px;font-weight:600;letter-spacing:.02em;transition:transform .14s ease}
.np-fab:hover{transform:translateY(-2px)}
.np-fab-ico{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;
  background:var(--np-accent);color:#06201d;font-size:13px;font-weight:800}
.np-panel{position:absolute;right:16px;bottom:158px;width:min(380px,calc(100vw - 32px));
  height:min(640px,calc(100vh - 182px));pointer-events:auto;display:flex;flex-direction:column;
  overflow:hidden;border:1px solid var(--np-line);border-radius:12px;background:var(--np-bg);
  color:var(--np-fg);box-shadow:0 18px 54px rgba(0,0,0,.42)}
.np-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--np-line);background:var(--np-bg2)}
.np-head-t{font-size:14px;font-weight:700;letter-spacing:.08em}
.np-head-sub{font-size:10px;letter-spacing:.18em;color:var(--np-accent);font-weight:700}
.np-x{margin-left:auto;width:26px;height:26px;flex:none;border:1px solid var(--np-line);border-radius:6px;
  background:transparent;color:var(--np-fg2);cursor:pointer;font-size:17px;line-height:1}
.np-x:hover{color:var(--np-fg);border-color:var(--np-accent)}
.np-hud{flex:none;display:flex;gap:0;border-bottom:1px solid var(--np-line);background:var(--np-bg2)}
.np-hud-cell{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:7px 10px;border-right:1px solid var(--np-line)}
.np-hud-cell:last-child{border-right:0}
.np-hud-cell b{font-size:9px;letter-spacing:.14em;color:var(--np-fg3);font-weight:600}
.np-hud-cell span{font-family:"Courier New",monospace;font-size:14px;font-weight:700;color:var(--np-amber);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.np-canvas-wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  overflow:hidden;background:#060d11;position:relative}
.np-canvas{display:block;touch-action:none;image-rendering:auto}
.np-ctrl{flex:none;display:flex;gap:7px;padding:8px 10px;border-top:1px solid var(--np-line);background:var(--np-bg2)}
.np-btn{flex:1;min-width:0;padding:11px 6px;border:1px solid var(--np-line);border-radius:8px;
  background:var(--np-bg);color:var(--np-fg);font-size:13px;font-weight:700;cursor:pointer;
  user-select:none;-webkit-user-select:none;touch-action:none;transition:background .1s}
.np-btn:active{background:var(--np-accent);color:#06201d}
.np-btn-launch{flex:1.2;border-color:var(--np-amber);color:var(--np-amber)}
.np-foot{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid var(--np-line);
  font-size:10px;color:var(--np-fg3);line-height:1.4}
.np-foot-tip{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.np-mini{flex:none;padding:4px 8px;border:1px solid var(--np-line);border-radius:6px;background:transparent;
  color:var(--np-fg2);font-size:10px;cursor:pointer;white-space:nowrap}
.np-mini:hover{color:var(--np-fg);border-color:var(--np-accent)}
.np-over{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;background:rgba(4,10,13,.78);pointer-events:auto}
.np-over h3{margin:0;font-size:22px;letter-spacing:.18em;color:var(--np-amber)}
.np-over p{margin:0;font-family:"Courier New",monospace;font-size:14px;color:var(--np-fg)}
.np-over button{margin-top:6px;padding:9px 22px;border:1px solid var(--np-amber);border-radius:8px;
  background:transparent;color:var(--np-amber);font-size:13px;font-weight:700;cursor:pointer}
`;

    /* ------------------------------------------------------------ 组件 */

    function isTyping(el) {
      if (!el) return false;
      const tag = el.tagName || "";
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
    }

    function PinballOverlay() {
      const [open, setOpen] = useState(false);
      const [hud, setHud] = useState(() => ({
        score: 0,
        hi: loadHi(),
        balls: 3,
        phase: "ready",
        mult: 1,
        msg: "",
        sound: true,
      }));

      const canvasRef = useRef(null);
      const wrapRef = useRef(null);
      const stRef = useRef(null);
      const inRef = useRef({ left: false, right: false });
      const hudRef = useRef(hud);
      const audioRef = useRef(null);
      const savedHiRef = useRef(hud.hi);
      const rafRef = useRef(0);

      useEffect(() => {
        if (!open) return undefined;

        if (!stRef.current) stRef.current = createGame(loadHi());
        const st = stRef.current;
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return undefined;
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        canvas.width = W * 2;
        canvas.height = H * 2;

        const resize = () => {
          const cw = wrap.clientWidth || 340;
          const chh = wrap.clientHeight || 480;
          const scale = Math.min(cw / W, chh / H);
          canvas.style.width = Math.max(120, Math.floor(W * scale)) + "px";
          canvas.style.height = Math.max(200, Math.floor(H * scale)) + "px";
        };
        resize();
        let ro = null;
        if (typeof window.ResizeObserver !== "undefined") {
          ro = new window.ResizeObserver(resize);
          ro.observe(wrap);
        }
        window.addEventListener("resize", resize);

        const onKeyDown = (e) => {
          if (isTyping(e.target) || isTyping(window.document.activeElement)) return;
          const k = e.key;
          if (k === "ArrowLeft" || k === "a" || k === "A") {
            inRef.current.left = true;
            e.preventDefault();
          } else if (k === "ArrowRight" || k === "d" || k === "D") {
            inRef.current.right = true;
            e.preventDefault();
          } else if (k === " " || k === "Spacebar") {
            e.preventDefault();
            if (!e.repeat) st.plunger.held = true;
          } else if (k === "r" || k === "R") {
            restartGame(st);
          }
        };
        const onKeyUp = (e) => {
          const k = e.key;
          if (k === "ArrowLeft" || k === "a" || k === "A") inRef.current.left = false;
          else if (k === "ArrowRight" || k === "d" || k === "D") inRef.current.right = false;
          else if (k === " " || k === "Spacebar") {
            st.plunger.held = false;
            launchBall(st, Math.min(1, st.plunger.charge / 1.1));
          }
        };
        const onBlur = () => {
          inRef.current.left = false;
          inRef.current.right = false;
          st.plunger.held = false;
        };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);

        let last = 0;
        const frame = (t) => {
          const dt = last ? Math.min(0.04, (t - last) / 1000) : 0.016;
          last = t;
          step(st, dt, inRef.current);
          draw(ctx, st);
          playCues(st.cues, audioRef, hudRef.current.sound);
          st.cues.length = 0;

          if (st.hi > savedHiRef.current) {
            savedHiRef.current = st.hi;
            saveHi(st.hi);
          }
          const next = {
            score: st.score,
            hi: st.hi,
            balls: st.balls,
            phase: st.phase,
            mult: st.mult,
            msg: st.msg,
            sound: hudRef.current.sound,
          };
          const cur = hudRef.current;
          if (
            cur.score !== next.score ||
            cur.hi !== next.hi ||
            cur.balls !== next.balls ||
            cur.phase !== next.phase ||
            cur.mult !== next.mult ||
            cur.msg !== next.msg ||
            cur.sound !== next.sound
          ) {
            hudRef.current = next;
            setHud(next);
          }
          rafRef.current = window.requestAnimationFrame(frame);
        };
        rafRef.current = window.requestAnimationFrame(frame);

        return () => {
          if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
          window.removeEventListener("keydown", onKeyDown);
          window.removeEventListener("keyup", onKeyUp);
          window.removeEventListener("blur", onBlur);
          window.removeEventListener("resize", resize);
          if (ro) ro.disconnect();
          onBlur();
          saveHi(st.hi);
        };
      }, [open]);

      const toggleSound = () => {
        const next = Object.assign({}, hudRef.current, { sound: !hudRef.current.sound });
        hudRef.current = next;
        setHud(next);
      };
      const doRestart = () => {
        const st = stRef.current;
        if (st) restartGame(st);
      };
      const pressL = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        inRef.current.left = true;
      };
      const releaseL = () => {
        inRef.current.left = false;
      };
      const pressR = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        inRef.current.right = true;
      };
      const releaseR = () => {
        inRef.current.right = false;
      };
      const launchDown = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const st = stRef.current;
        if (st) st.plunger.held = true;
      };
      const launchUp = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const st = stRef.current;
        if (!st) return;
        st.plunger.held = false;
        launchBall(st, Math.min(1, st.plunger.charge / 1.1));
      };

      return h(
        "div",
        { className: "np-root" },
        h("style", null, CSS),
        !open
          ? h(
              "button",
              {
                className: "np-fab",
                title: "诺基亚弹珠台",
                onClick: () => setOpen(true),
              },
              h("span", { className: "np-fab-ico" }, "◉"),
              "弹珠台"
            )
          : h(
              "div",
              { className: "np-panel" },
              h(
                "div",
                { className: "np-head" },
                h("span", { className: "np-head-t" }, "弹珠台"),
                h("span", { className: "np-head-sub" }, "NOKIA PINBALL"),
                h("button", { className: "np-x", onClick: () => setOpen(false) }, "×")
              ),
              h(
                "div",
                { className: "np-hud" },
                h(
                  "div",
                  { className: "np-hud-cell" },
                  h("b", null, "分数"),
                  h("span", null, pad(hud.score, 7))
                ),
                h(
                  "div",
                  { className: "np-hud-cell" },
                  h("b", null, "最高"),
                  h("span", null, pad(hud.hi, 7))
                ),
                h(
                  "div",
                  { className: "np-hud-cell" },
                  h("b", null, "剩余球"),
                  h("span", null, "●".repeat(hud.balls) + "○".repeat(Math.max(0, 3 - hud.balls)))
                ),
                h(
                  "div",
                  { className: "np-hud-cell" },
                  h("b", null, "倍率"),
                  h("span", null, "×" + hud.mult)
                )
              ),
              h(
                "div",
                { className: "np-canvas-wrap", ref: wrapRef },
                h("canvas", { className: "np-canvas", ref: canvasRef })
              ),
              h(
                "div",
                { className: "np-ctrl" },
                h(
                  "button",
                  {
                    className: "np-btn",
                    onPointerDown: pressL,
                    onPointerUp: releaseL,
                    onPointerLeave: releaseL,
                    onPointerCancel: releaseL,
                  },
                  "◀ 左"
                ),
                h(
                  "button",
                  {
                    className: "np-btn np-btn-launch",
                    onPointerDown: launchDown,
                    onPointerUp: launchUp,
                    onPointerCancel: launchUp,
                  },
                  "发射"
                ),
                h(
                  "button",
                  {
                    className: "np-btn",
                    onPointerDown: pressR,
                    onPointerUp: releaseR,
                    onPointerLeave: releaseR,
                    onPointerCancel: releaseR,
                  },
                  "右 ▶"
                )
              ),
              h(
                "div",
                { className: "np-foot" },
                h("span", { className: "np-foot-tip" }, "← → 翻板 · 空格蓄力发射 · R 重开"),
                h("button", { className: "np-mini", onClick: toggleSound }, hud.sound ? "♪ 开" : "♪ 关"),
                h("button", { className: "np-mini", onClick: doRestart }, "重开")
              ),
              hud.phase === "over"
                ? h(
                    "div",
                    { className: "np-over" },
                    h("h3", null, "GAME OVER"),
                    h("p", null, "得分 " + pad(hud.score, 7)),
                    h("p", null, "最高 " + pad(hud.hi, 7)),
                    h("button", { onClick: doRestart }, "再来一局")
                  )
                : null
            )
      );
    }

    /* ------------------------------------------------------------ 注册 */

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "nokia-pinball",
            order: 61,
            label: () => "弹珠台",
          },
          PinballOverlay
        )
      );
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = {
      createGame,
      restartGame,
      launchBall,
      step,
      draw,
      WALLS,
      SLINGS,
      BUMPERS,
      TARGETS,
      ROLLOVERS,
      W,
      H,
      BALL_R,
      L_REST,
      R_REST,
      L_ACTIVE,
      R_ACTIVE,
      flipperSegment,
      loadHi,
      saveHi,
      PinballOverlay,
    };
    return module.exports;
  },
});
