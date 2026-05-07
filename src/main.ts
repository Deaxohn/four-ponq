import Phaser from "phaser";
import "./styles.css";

type GameMode = "menu" | "playing" | "paused" | "matchOver";
type BotDifficulty = "easy" | "medium" | "hard";
type TouchType = "none" | "player" | "triangle";

interface InputAction {
  counterclockwise: boolean;
  clockwise: boolean;
}

interface PlayerState {
  id: number;
  name: string;
  color: number;
  cssColor: string;
  shields: number;
  eliminated: boolean;
  paddleAngle: number;
  arcStart: number;
  arcEnd: number;
  humanControlled: boolean;
  lastHumanInputAt: number;
  charge: number;
}

interface HudPlayerState {
  name: string;
  cssColor: string;
  shields: number;
  eliminated: boolean;
  charge: number;
}

interface HudState {
  players: HudPlayerState[];
  message: string;
  mode: GameMode;
  botFill: boolean;
  botDifficulty: BotDifficulty;
}

interface ArenaGeometry {
  center: Phaser.Math.Vector2;
  radius: number;
  paddleThickness: number;
  paddleAngleSpan: number;
  triangleRadius: number;
}

const MAX_SHIELDS = 5;
const BALL_RADIUS = 9;
const TAU = Math.PI * 2;
const TRIANGLE_GRAVITY = 21000;
const TRIANGLE_ROTATION_SPEED = 0.34;
const TRIANGLE_PHASE_DELAY = 1000;
const PADDLE_CURVE_RESPONSE = 0.72;
const PADDLE_RELEASE_GAP = 2.5;
const PADDLE_CONCAVITY = 0.48;
const MAX_CHARGE = 10;
const REPEAT_HIT_BOOST = 1.08;
const CATCH_DURATION = 3000;
const CATCH_LAUNCH_BOOST = 2;
const SPAWN_DELAY = 850;
const BASE_BALL_SPEED = 380;
const MENU_BALL_SPEED = 180;
const BASE_PADDLE_SPEED = 2.25;
const PADDLE_SPEED_RAMP = 0.045;
const MAX_PADDLE_SPEED_MULTIPLIER = 1.36;
const MAX_BALL_SPEED = 840;
const MAX_CHARGED_BALL_SPEED = 980;

const BOT_DIFFICULTY_SPEED: Record<BotDifficulty, number> = {
  easy: 0.42,
  medium: 0.68,
  hard: 0.94
};

class FourPongScene extends Phaser.Scene {
  private gfx!: Phaser.GameObjects.Graphics;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private players: PlayerState[] = [];
  private ball = new Phaser.Math.Vector2(0, 0);
  private velocity = new Phaser.Math.Vector2(0, 0);
  private mode: GameMode = "menu";
  private message = "Circular 4 Player is ready.";
  private botFill = true;
  private botDifficulty: BotDifficulty = "medium";
  private elapsed = 0;
  private lastScoreAt = 0;
  private triangleCollisionDisabledUntil = 0;
  private roundNumber = 0;
  private roundResolving = false;
  private lastTouchType: TouchType = "none";
  private lastTouchPlayerId?: number;
  private caughtByPlayerId?: number;
  private caughtAt = 0;
  private caughtLaunchSpeed = 0;
  private roundReadyAt = 0;

  constructor() {
    super("four-pong");
  }

  create() {
    this.gfx = this.add.graphics();
    window.addEventListener("four-pong:start", this.handleStartEvent);
    window.addEventListener("four-pong:toggle-pause", this.handlePauseEvent);
    window.addEventListener("four-pong:toggle-bots", this.handleBotEvent);
    window.addEventListener("four-pong:set-difficulty", this.handleDifficultyEvent);
    window.addEventListener("keydown", this.handleWindowKeyDown);

    this.keys = this.input.keyboard!.addKeys({
      counterclockwise: Phaser.Input.Keyboard.KeyCodes.A,
      clockwise: Phaser.Input.Keyboard.KeyCodes.D,
      reset: Phaser.Input.Keyboard.KeyCodes.R,
      pause: Phaser.Input.Keyboard.KeyCodes.SPACE,
      escape: Phaser.Input.Keyboard.KeyCodes.ESC,
      bot: Phaser.Input.Keyboard.KeyCodes.B
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.players = [
      this.createPlayer(1, "P1", 0x62e6ff, "#62e6ff"),
      this.createPlayer(2, "P2", 0xff6f91, "#ff6f91"),
      this.createPlayer(3, "P3", 0xf8d66d, "#f8d66d"),
      this.createPlayer(4, "P4", 0x69db7c, "#69db7c")
    ];

    this.scale.on("resize", this.handleResize, this);
    this.rebuildArcs();
    this.resetRound(undefined, false);
    this.emitHud();
  }

  shutdown() {
    window.removeEventListener("four-pong:start", this.handleStartEvent);
    window.removeEventListener("four-pong:toggle-pause", this.handlePauseEvent);
    window.removeEventListener("four-pong:toggle-bots", this.handleBotEvent);
    window.removeEventListener("four-pong:set-difficulty", this.handleDifficultyEvent);
    window.removeEventListener("keydown", this.handleWindowKeyDown);
  }

  update(_time: number, delta: number) {
    const dt = Math.min(delta / 1000, 0.034);
    this.elapsed += delta;

    if (Phaser.Input.Keyboard.JustDown(this.keys.reset)) {
      this.restartMatch();
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.bot)) {
      this.toggleBotFill();
    }

    if (this.mode === "playing") {
      this.updatePaddles(dt);
      if (this.caughtByPlayerId !== undefined) {
        this.updateCaughtBall();
        if (!this.keys.pause.isDown || this.elapsed - this.caughtAt >= CATCH_DURATION) {
          this.launchCaughtBall();
        }
      } else if (this.elapsed < this.roundReadyAt) {
        // Give players a readable beat before the serve starts moving.
      } else {
        this.applyTriangleGravity(dt, 275, MAX_BALL_SPEED);
        this.advanceBall(dt);
      }
    } else if (this.mode === "menu") {
      this.previewMenuMotion(dt);
    }

    this.renderArena();
  }

  private createPlayer(id: number, name: string, color: number, cssColor: string): PlayerState {
    return {
      id,
      name,
      color,
      cssColor,
      shields: MAX_SHIELDS,
      eliminated: false,
      paddleAngle: 0,
      arcStart: 0,
      arcEnd: TAU,
      humanControlled: id === 1,
      lastHumanInputAt: -9999,
      charge: 0
    };
  }

  private startGame() {
    if (this.mode === "paused") {
      this.mode = "playing";
      this.message = "Back in motion.";
      this.emitHud();
      return;
    }

    this.restartMatch(this.mode === "matchOver" ? "New match. Guard your arc." : "Guard your arc.");
  }

  private restartMatch(message = "Fresh circle. Guard your arc.") {
    for (const player of this.players) {
      player.shields = MAX_SHIELDS;
      player.eliminated = false;
      player.lastHumanInputAt = -9999;
      player.charge = 0;
    }

    this.roundNumber = 0;
    this.clearTouchState();
    this.clearCatchState();
    this.roundResolving = false;
    this.mode = "playing";
    this.message = message;
    this.rebuildArcs();
    this.resetRound();
    this.emitHud();
  }

  private updatePaddles(dt: number) {
    const action = this.readLocalAction();
    const human = this.players.find((player) => player.humanControlled && !player.eliminated);
    const speed = BASE_PADDLE_SPEED * this.paddleSpeedMultiplier();

    if (human && (action.counterclockwise || action.clockwise)) {
      const direction = (action.clockwise ? 1 : 0) - (action.counterclockwise ? 1 : 0);
      human.paddleAngle += direction * speed * dt;
      human.lastHumanInputAt = this.elapsed;
      this.clampPaddleToArc(human);
    }

    if (!this.botFill) {
      return;
    }

    const targetAngle = normalizeAngle(Math.atan2(this.ball.y - this.arena().center.y, this.ball.x - this.arena().center.x));
    const botSpeed = speed * BOT_DIFFICULTY_SPEED[this.botDifficulty];
    for (const player of this.players) {
      if (player.eliminated || player.humanControlled) {
        continue;
      }

      const target = clampAngleToArc(targetAngle, player.arcStart, player.arcEnd, this.paddleSafetyMargin(player));
      const delta = shortestAngleDelta(player.paddleAngle, target);
      player.paddleAngle = normalizeAngle(player.paddleAngle + Phaser.Math.Clamp(delta, -botSpeed * dt, botSpeed * dt));
      this.clampPaddleToArc(player);
    }
  }

  private readLocalAction(): InputAction {
    return {
      counterclockwise: this.keys.counterclockwise.isDown,
      clockwise: this.keys.clockwise.isDown
    };
  }

  private handlePaddleCollisions() {
    const arena = this.arena();
    for (const player of this.activePlayers()) {
      const hit = this.paddleHitTest(arena, player);
      if (!hit) {
        continue;
      }

      if (this.velocity.dot(hit.normal) >= 0) {
        continue;
      }

      const tangent = new Phaser.Math.Vector2(-hit.radial.y, hit.radial.x);
      const roundedNormal = hit.normal.clone().add(tangent.scale(hit.offset * PADDLE_CURVE_RESPONSE)).normalize();
      const repeatHit = this.lastTouchType === "player" && this.lastTouchPlayerId === player.id;

      this.addCharge(player);

      if (this.canCatchBall(player)) {
        this.startCatch(player);
        return;
      }

      this.reflectBall(roundedNormal);
      if (repeatHit) {
        this.boostBallSpeed(REPEAT_HIT_BOOST);
        this.message = `${player.name} double-tapped the ball.`;
      }
      this.lastTouchType = "player";
      this.lastTouchPlayerId = player.id;
      this.ball.copy(hit.contact.add(roundedNormal.scale(BALL_RADIUS + PADDLE_RELEASE_GAP)));
      this.emitHud();
      return;
    }
  }

  private advanceBall(dt: number) {
    const distance = this.velocity.length() * dt;
    const steps = Math.max(1, Math.ceil(distance / (BALL_RADIUS * 0.65)));
    const stepDt = dt / steps;

    for (let index = 0; index < steps; index += 1) {
      this.ball.add(this.velocity.clone().scale(stepDt));
      this.handleTriangleCollision();
      this.handlePaddleCollisions();
      this.handleGoals();

      if (this.roundResolving || this.caughtByPlayerId !== undefined || this.mode !== "playing") {
        return;
      }
    }
  }

  private paddleHitTest(arena: ArenaGeometry, player: PlayerState) {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const ballDelta = this.ball.clone().subtract(center);
    const localX = ballDelta.dot(tangent);
    const localY = ballDelta.dot(radial);
    const halfWidth = this.paddleHalfWidth(arena);
    const halfHeight = this.paddleHalfHeight(arena);
    const clampedX = Phaser.Math.Clamp(localX, -halfWidth, halfWidth);
    const curveOffset = Phaser.Math.Clamp(clampedX / halfWidth, -1, 1);
    const innerY = this.paddleInnerY(curveOffset, halfHeight);
    const cappedY = Math.min(halfHeight, Math.max(innerY, localY));
    const clampedY = Math.abs(localX) > halfWidth ? cappedY : innerY;
    const contact = this.paddleLocalPoint(center, tangent, radial, clampedX, clampedY);
    const separation = this.ball.clone().subtract(contact);
    const distance = separation.length();

    if (distance > BALL_RADIUS) {
      return undefined;
    }

    const slope = this.paddleInnerSlope(curveOffset, halfWidth, halfHeight);
    const curveNormal = tangent.clone().scale(slope).subtract(radial).normalize();
    const normal = distance > 0 ? separation.normalize() : curveNormal;
    return {
      contact,
      normal,
      radial,
      offset: curveOffset
    };
  }

  private applyTriangleGravity(dt: number, minSpeed: number, maxSpeed: number) {
    const arena = this.arena();
    const towardTriangle = arena.center.clone().subtract(this.ball);
    const distanceSq = Math.max(towardTriangle.lengthSq(), 1600);
    const force = Math.min(48, TRIANGLE_GRAVITY / distanceSq);
    this.velocity.add(towardTriangle.normalize().scale(force * dt));

    const speed = this.velocity.length();
    if (speed > 0) {
      this.velocity.normalize().scale(Phaser.Math.Clamp(speed, minSpeed, maxSpeed));
    }
  }

  private handleTriangleCollision() {
    const arena = this.arena();
    const vertices = this.triangleVertices(arena);

    if (pointInTriangle(this.ball, vertices[0], vertices[1], vertices[2])) {
      this.triangleCollisionDisabledUntil = this.elapsed + TRIANGLE_PHASE_DELAY;
      this.clearTouchState();
      this.lastTouchType = "triangle";
      return;
    }

    if (this.elapsed < this.triangleCollisionDisabledUntil) {
      return;
    }

    for (let index = 0; index < vertices.length; index += 1) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const closest = closestPointOnSegment(this.ball, start, end);
      const delta = this.ball.clone().subtract(closest);
      const distance = delta.length();

      if (distance >= BALL_RADIUS || distance === 0) {
        continue;
      }

      const normal = delta.normalize();
      this.reflectBall(normal);
      this.ball.copy(closest.add(normal.scale(BALL_RADIUS + 0.5)));
      this.clearTouchState();
      this.lastTouchType = "triangle";
      return;
    }
  }

  private handleGoals() {
    if (this.roundResolving) {
      return;
    }

    const arena = this.arena();
    const fromCenter = this.ball.clone().subtract(arena.center);

    if (fromCenter.length() <= arena.radius + BALL_RADIUS || this.elapsed - this.lastScoreAt < 350) {
      return;
    }

    this.roundResolving = true;
    this.clearTouchState();
    this.clearCatchState();

    const scorer = this.playerForAngle(normalizeAngle(Math.atan2(fromCenter.y, fromCenter.x)));
    if (!scorer) {
      this.resetRound();
      return;
    }

    this.lastScoreAt = this.elapsed;
    scorer.shields -= 1;
    scorer.eliminated = scorer.shields <= 0;

    if (scorer.eliminated) {
      this.message = `${scorer.name} is out. The circle closes.`;
      this.rebuildArcs();
    } else {
      this.message = `${scorer.name} cracked. ${scorer.shields} shields remain.`;
    }

    const remaining = this.activePlayers();
    if (remaining.length <= 1) {
      this.message = `${remaining[0]?.name ?? "No one"} wins. Start again from the menu.`;
      this.mode = "matchOver";
    } else {
      this.time.delayedCall(420, () => {
        if (this.mode === "playing") {
          this.resetRound(scorer.paddleAngle);
        }
      });
    }

    this.emitHud();
  }

  private reflectBall(normal: Phaser.Math.Vector2) {
    const speed = Math.min(this.velocity.length() * 1.02, MAX_BALL_SPEED);
    const reflected = this.velocity.clone().subtract(normal.clone().scale(2 * this.velocity.dot(normal)));
    this.velocity.copy(reflected.normalize().scale(speed));
  }

  private boostBallSpeed(multiplier: number) {
    const speed = this.velocity.length();
    if (speed > 0) {
      this.velocity.normalize().scale(Math.min(speed * multiplier, MAX_BALL_SPEED));
    }
  }

  private addCharge(player: PlayerState) {
    player.charge = Math.min(MAX_CHARGE, player.charge + 1);
  }

  private canCatchBall(player: PlayerState) {
    return player.humanControlled && player.charge >= MAX_CHARGE && this.keys.pause.isDown;
  }

  private startCatch(player: PlayerState) {
    this.caughtByPlayerId = player.id;
    this.caughtAt = this.elapsed;
    this.caughtLaunchSpeed = Math.max(this.velocity.length(), 360);
    this.velocity.set(0, 0);
    this.updateCaughtBall();
    this.lastTouchType = "player";
    this.lastTouchPlayerId = player.id;
    this.message = `${player.name} caught the ball. Release Space to fire.`;
    this.emitHud();
  }

  private updateCaughtBall() {
    const player = this.players.find((entry) => entry.id === this.caughtByPlayerId && !entry.eliminated);
    if (!player) {
      this.clearCatchState();
      return;
    }

    this.ball.copy(this.paddleCatchPoint(this.arena(), player));
  }

  private launchCaughtBall() {
    const player = this.players.find((entry) => entry.id === this.caughtByPlayerId && !entry.eliminated);
    if (!player) {
      this.clearCatchState();
      return;
    }

    const arena = this.arena();
    const radial = this.paddleCenter(arena, player).subtract(arena.center).normalize();
    const launchSpeed = Math.min(Math.max(BASE_BALL_SPEED, this.caughtLaunchSpeed) * CATCH_LAUNCH_BOOST, MAX_CHARGED_BALL_SPEED);
    this.ball.copy(this.paddleCatchPoint(arena, player));
    this.velocity.copy(radial.scale(-launchSpeed));
    player.charge = 0;
    this.lastTouchType = "player";
    this.lastTouchPlayerId = player.id;
    this.clearCatchState();
    this.message = `${player.name} fired the charged shot.`;
    this.emitHud();
  }

  private clearCatchState() {
    this.caughtByPlayerId = undefined;
    this.caughtAt = 0;
    this.caughtLaunchSpeed = 0;
  }

  private clearTouchState() {
    this.lastTouchType = "none";
    this.lastTouchPlayerId = undefined;
  }

  private renderArena() {
    const width = this.scale.width;
    const height = this.scale.height;
    const arena = this.arena();

    this.gfx.clear();
    this.gfx.fillStyle(0x061016, 1);
    this.gfx.fillRect(0, 0, width, height);

    this.drawBackgroundRings(arena);
    this.drawPlayerArcs(arena);
    this.drawTriangle(arena);
    this.drawPaddles(arena);
    this.drawBall();
  }

  private drawBackgroundRings(arena: ArenaGeometry) {
    this.gfx.lineStyle(1, 0x203240, 0.55);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius * 0.5);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius * 0.75);
    this.gfx.lineStyle(2, 0x29485a, 0.65);
    this.gfx.strokeCircle(arena.center.x, arena.center.y, arena.radius);
  }

  private drawPlayerArcs(arena: ArenaGeometry) {
    for (const player of this.activePlayers()) {
      this.gfx.lineStyle(8, player.color, 0.72);
      this.gfx.beginPath();
      this.gfx.arc(arena.center.x, arena.center.y, arena.radius, player.arcStart, player.arcEnd, false);
      this.gfx.strokePath();
    }
  }

  private drawTriangle(arena: ArenaGeometry) {
    const vertices = this.triangleVertices(arena);
    this.gfx.fillStyle(0x102431, 1);
    this.gfx.lineStyle(2, 0x9ddcff, 0.62);
    this.gfx.beginPath();
    this.gfx.moveTo(vertices[0].x, vertices[0].y);
    this.gfx.lineTo(vertices[1].x, vertices[1].y);
    this.gfx.lineTo(vertices[2].x, vertices[2].y);
    this.gfx.closePath();
    this.gfx.fillPath();
    this.gfx.strokePath();

    this.gfx.lineStyle(1, 0xf4fbff, 0.22);
    this.gfx.beginPath();
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[0].x, vertices[0].y);
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[1].x, vertices[1].y);
    this.gfx.moveTo(arena.center.x, arena.center.y);
    this.gfx.lineTo(vertices[2].x, vertices[2].y);
    this.gfx.strokePath();
  }

  private drawPaddles(arena: ArenaGeometry) {
    for (const player of this.activePlayers()) {
      this.gfx.fillStyle(player.color, 1);
      this.gfx.lineStyle(2, 0xf4fbff, 0.38);
      this.gfx.beginPath();
      this.traceConcavePaddle(arena, player);
      this.gfx.closePath();
      this.gfx.fillPath();
      this.gfx.strokePath();
    }
  }

  private traceConcavePaddle(arena: ArenaGeometry, player: PlayerState) {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const halfWidth = this.paddleHalfWidth(arena);
    const halfHeight = this.paddleHalfHeight(arena);
    const steps = 18;
    const outerLip = halfHeight * 0.1;

    for (let index = 0; index <= steps; index += 1) {
      const offset = -1 + index / steps * 2;
      const point = this.paddleLocalPoint(center, tangent, radial, offset * halfWidth, halfHeight + outerLip * (1 - offset * offset));
      if (index === 0) {
        this.gfx.moveTo(point.x, point.y);
      } else {
        this.gfx.lineTo(point.x, point.y);
      }
    }

    for (let index = steps; index >= 0; index -= 1) {
      const offset = -1 + index / steps * 2;
      const point = this.paddleLocalPoint(center, tangent, radial, offset * halfWidth, this.paddleInnerY(offset, halfHeight));
      this.gfx.lineTo(point.x, point.y);
    }
  }

  private paddleCenter(arena: ArenaGeometry, player: PlayerState) {
    return pointOnCircle(arena.center, player.paddleAngle, arena.radius);
  }

  private paddleCatchPoint(arena: ArenaGeometry, player: PlayerState) {
    const center = this.paddleCenter(arena, player);
    const radial = center.clone().subtract(arena.center).normalize();
    const tangent = new Phaser.Math.Vector2(-radial.y, radial.x);
    const innerY = this.paddleInnerY(0, this.paddleHalfHeight(arena));
    return this.paddleLocalPoint(center, tangent, radial, 0, innerY - BALL_RADIUS - PADDLE_RELEASE_GAP);
  }

  private paddleHalfWidth(arena: ArenaGeometry) {
    return Math.max(37, arena.radius * arena.paddleAngleSpan * 0.54);
  }

  private paddleHalfHeight(arena: ArenaGeometry) {
    return Math.max(14, arena.paddleThickness * 0.74);
  }

  private paddleInnerY(offset: number, halfHeight: number) {
    const endDip = halfHeight * 0.12;
    return -halfHeight + halfHeight * PADDLE_CONCAVITY * (1 - offset * offset) - endDip * offset * offset;
  }

  private paddleInnerSlope(offset: number, halfWidth: number, halfHeight: number) {
    return (-2 * halfHeight * (PADDLE_CONCAVITY + 0.12) * offset) / halfWidth;
  }

  private paddleLocalPoint(
    center: Phaser.Math.Vector2,
    tangent: Phaser.Math.Vector2,
    radial: Phaser.Math.Vector2,
    x: number,
    y: number
  ) {
    return center.clone().add(tangent.clone().scale(x)).add(radial.clone().scale(y));
  }

  private paddleSpeedMultiplier() {
    const completedRounds = Math.max(0, this.roundNumber - 1);
    return Math.min(MAX_PADDLE_SPEED_MULTIPLIER, 1 + completedRounds * PADDLE_SPEED_RAMP);
  }

  private drawBall() {
    this.gfx.fillStyle(0xf4fbff, 1);
    this.gfx.fillCircle(this.ball.x, this.ball.y, BALL_RADIUS);
    this.gfx.lineStyle(2, 0x9ddcff, 0.32);
    this.gfx.strokeCircle(this.ball.x, this.ball.y, BALL_RADIUS + 4);
  }

  private rebuildArcs() {
    const active = this.activePlayers();
    const span = TAU / Math.max(active.length, 1);
    const startOffset = -Math.PI / 2 - span / 2;

    active.forEach((player, index) => {
      player.arcStart = normalizeAngle(startOffset + index * span);
      player.arcEnd = player.arcStart + span;
      player.paddleAngle = normalizeAngle(player.arcStart + span / 2);
      this.clampPaddleToArc(player);
    });
  }

  private resetRound(targetAngle?: number, countRound = true) {
    const arena = this.arena();
    const angle = normalizeAngle((targetAngle ?? Phaser.Math.FloatBetween(0, TAU)) + Phaser.Math.FloatBetween(-0.32, 0.32));
    const speed = this.mode === "menu" ? MENU_BALL_SPEED : BASE_BALL_SPEED;

    if (countRound && this.mode === "playing") {
      this.roundNumber += 1;
    }

    this.ball.copy(arena.center);
    this.velocity.set(Math.cos(angle) * speed, Math.sin(angle) * speed);
    this.triangleCollisionDisabledUntil = this.elapsed + TRIANGLE_PHASE_DELAY;
    this.roundReadyAt = this.mode === "playing" ? this.elapsed + SPAWN_DELAY : 0;
    this.roundResolving = false;
    this.clearTouchState();
    this.clearCatchState();
  }

  private previewMenuMotion(dt: number) {
    this.applyTriangleGravity(dt, 150, 260);
    this.ball.add(this.velocity.clone().scale(dt));
    this.handleTriangleCollision();

    const arena = this.arena();
    const fromCenter = this.ball.clone().subtract(arena.center);
    if (fromCenter.length() > arena.radius * 0.72) {
      const normal = fromCenter.normalize();
      this.reflectBall(normal);
      this.ball.copy(arena.center.clone().add(normal.scale(arena.radius * 0.72)));
    }
  }

  public togglePause() {
    if (this.mode === "menu" || this.mode === "matchOver") {
      return;
    }

    this.mode = this.mode === "paused" ? "playing" : "paused";
    this.message = this.mode === "paused" ? "Paused. Press Esc, Space, or Resume." : "Back in motion.";
    this.emitHud();
  }

  private toggleBotFill() {
    this.botFill = !this.botFill;
    this.message = this.botFill ? "Bot fill on for computer opponents. P1 stays yours." : "Bot fill off. P1 has the circle.";
    this.emitHud();
  }

  private setBotDifficulty(difficulty: BotDifficulty) {
    this.botDifficulty = difficulty;
    this.message = `Computer difficulty set to ${difficulty}.`;
    this.emitHud();
  }

  private arena(): ArenaGeometry {
    const width = this.scale.width || 960;
    const height = this.scale.height || 640;
    const hudSafeTop = width < 760 ? 142 : 92;
    const controlsSafeBottom = width < 760 ? 118 : 70;
    const centerY = hudSafeTop + (height - hudSafeTop - controlsSafeBottom) / 2;
    const radius = Math.max(126, Math.min(width * 0.43, (height - hudSafeTop - controlsSafeBottom) * 0.48));

    return {
      center: new Phaser.Math.Vector2(width / 2, centerY),
      radius,
      paddleThickness: Math.max(16, Math.min(24, radius * 0.085)),
      paddleAngleSpan: Math.max(0.28, Math.min(0.52, 76 / radius)),
      triangleRadius: Math.max(32, Math.min(56, radius * 0.18))
    };
  }

  private triangleVertices(arena: ArenaGeometry) {
    const rotation = this.elapsed / 1000 * TRIANGLE_ROTATION_SPEED - Math.PI / 2;
    return [0, 1, 2].map((index) => pointOnCircle(arena.center, rotation + index * TAU / 3, arena.triangleRadius));
  }

  private playerForAngle(angle: number) {
    return this.activePlayers().find((player) => angleInArc(angle, player.arcStart, player.arcEnd));
  }

  private activePlayers() {
    return this.players.filter((player) => !player.eliminated);
  }

  private clampPaddleToArc(player: PlayerState) {
    player.paddleAngle = clampAngleToArc(player.paddleAngle, player.arcStart, player.arcEnd, this.paddleSafetyMargin(player));
  }

  private paddleSafetyMargin(player: PlayerState) {
    return Math.min(0.18, Math.max(0.04, (player.arcEnd - player.arcStart) * 0.08));
  }

  private handleResize() {
    if (this.caughtByPlayerId !== undefined) {
      this.updateCaughtBall();
      return;
    }

    this.resetRound(undefined, false);
  }

  private handleStartEvent = () => {
    this.startGame();
  };

  private handlePauseEvent = () => {
    this.togglePause();
  };

  private handleBotEvent = () => {
    this.toggleBotFill();
  };

  private handleDifficultyEvent = (event: Event) => {
    const difficulty = (event as CustomEvent<BotDifficulty>).detail;
    if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard") {
      this.setBotDifficulty(difficulty);
    }
  };

  private handleWindowKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.togglePause();
      return;
    }

    if (event.code === "Space" && this.mode !== "playing") {
      event.preventDefault();
      this.togglePause();
    }
  };

  private emitHud() {
    const state: HudState = {
      players: this.players.map(({ name, cssColor, shields, eliminated, charge }) => ({ name, cssColor, shields, eliminated, charge })),
      message: this.message,
      mode: this.mode,
      botFill: this.botFill,
      botDifficulty: this.botDifficulty
    };

    window.dispatchEvent(new CustomEvent<HudState>("four-pong:hud", { detail: state }));
  }
}

function normalizeAngle(angle: number) {
  return Phaser.Math.Wrap(angle, 0, TAU);
}

function angleInArc(angle: number, start: number, end: number) {
  const normalized = normalizeAngle(angle);
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalized - normalizedStart);
  return relative <= span;
}

function clampAngleToArc(angle: number, start: number, end: number, margin: number) {
  const normalizedStart = normalizeAngle(start);
  const span = end - start;
  const relative = normalizeAngle(normalizeAngle(angle) - normalizedStart);
  const clamped = Phaser.Math.Clamp(relative, margin, Math.max(margin, span - margin));
  return normalizeAngle(normalizedStart + clamped);
}

function shortestAngleDelta(from: number, to: number) {
  return Phaser.Math.Angle.Wrap(to - from);
}

function pointOnCircle(center: Phaser.Math.Vector2, angle: number, radius: number) {
  return new Phaser.Math.Vector2(
    center.x + Math.cos(angle) * radius,
    center.y + Math.sin(angle) * radius
  );
}

function closestPointOnSegment(point: Phaser.Math.Vector2, start: Phaser.Math.Vector2, end: Phaser.Math.Vector2) {
  const segment = end.clone().subtract(start);
  const lengthSq = segment.lengthSq();
  if (lengthSq === 0) {
    return start.clone();
  }

  const t = Phaser.Math.Clamp(point.clone().subtract(start).dot(segment) / lengthSq, 0, 1);
  return start.clone().add(segment.scale(t));
}

function pointInTriangle(point: Phaser.Math.Vector2, a: Phaser.Math.Vector2, b: Phaser.Math.Vector2, c: Phaser.Math.Vector2) {
  const area = triangleSign(point, a, b);
  const sideB = triangleSign(point, b, c);
  const sideC = triangleSign(point, c, a);
  const hasNegative = area < 0 || sideB < 0 || sideC < 0;
  const hasPositive = area > 0 || sideB > 0 || sideC > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(p1: Phaser.Math.Vector2, p2: Phaser.Math.Vector2, p3: Phaser.Math.Vector2) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "game-root",
  backgroundColor: "#061016",
  scale: {
    mode: Phaser.Scale.RESIZE,
    parent: "game-root",
    width: "100%",
    height: "100%"
  },
  scene: FourPongScene,
  render: {
    antialias: true,
    pixelArt: false
  }
});

const scoreStrip = document.querySelector<HTMLDivElement>("#score-strip")!;
const statusChip = document.querySelector<HTMLDivElement>("#status-chip")!;
const pauseButton = document.querySelector<HTMLButtonElement>("#pause-button")!;
const menuOverlay = document.querySelector<HTMLDivElement>("#menu-overlay")!;
const startButton = document.querySelector<HTMLButtonElement>("#start-button")!;
const botToggleButton = document.querySelector<HTMLButtonElement>("#bot-toggle-button")!;
const menuBotState = document.querySelector<HTMLSpanElement>("#menu-bot-state")!;
const menuTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu-tab]"));
const menuTabPanels = Array.from(document.querySelectorAll<HTMLDivElement>("[data-menu-panel]"));
const difficultyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-difficulty]"));
const menuDifficultyState = document.querySelector<HTMLSpanElement>("#menu-difficulty-state")!;

window.addEventListener("four-pong:hud", (event) => {
  const state = (event as CustomEvent<HudState>).detail;
  scoreStrip.innerHTML = state.players.map((player) => {
    const shields = Array.from({ length: MAX_SHIELDS }, (_, index) => {
      const live = index < player.shields;
      return `<span class="pip ${live ? "live" : ""}" style="--player-color: ${player.cssColor}"></span>`;
    }).join("");
    const charge = Phaser.Math.Clamp(player.charge / MAX_CHARGE, 0, 1);
    return `<article class="score-card ${player.eliminated ? "out" : ""}">
      <span class="name" style="--player-color: ${player.cssColor}">${player.name}</span>
      <span class="pips">${shields}</span>
      <span class="charge-meter" aria-label="${player.name} charge ${player.charge} of ${MAX_CHARGE}">
        <span style="--player-color: ${player.cssColor}; --charge: ${charge}"></span>
      </span>
    </article>`;
  }).join("");

  statusChip.textContent = `${state.message} ${state.botFill ? "Bot fill on." : "Bot fill off."}`;
  pauseButton.textContent = state.mode === "paused" ? "Resume" : "Pause";
  pauseButton.disabled = state.mode === "menu" || state.mode === "matchOver";
  menuOverlay.hidden = state.mode === "playing";
  startButton.textContent = state.mode === "paused" ? "Resume" : state.mode === "matchOver" ? "Start Again" : "Start";
  botToggleButton.textContent = state.botFill ? "Bot Fill: On" : "Bot Fill: Off";
  menuBotState.textContent = state.botFill ? "On" : "Off";
  menuDifficultyState.textContent = titleCase(state.botDifficulty);
  difficultyButtons.forEach((button) => {
    const active = button.dataset.difficulty === state.botDifficulty;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
});

startButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:start"));
});

botToggleButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:toggle-bots"));
});

menuTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.menuTab;
    menuTabs.forEach((entry) => entry.classList.toggle("active", entry === button));
    menuTabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.menuPanel !== target;
    });
  });
});

difficultyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const difficulty = button.dataset.difficulty;
    if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard") {
      window.dispatchEvent(new CustomEvent<BotDifficulty>("four-pong:set-difficulty", { detail: difficulty }));
    }
  });
});

pauseButton.addEventListener("click", () => {
  window.dispatchEvent(new Event("four-pong:toggle-pause"));
});

void game;

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
