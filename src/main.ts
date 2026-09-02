// Bootstrap + game loop. Fixed-timestep physics at 120 Hz under a variable
// render rate, adaptive pixel ratio, and all the cross-system wiring:
// input -> physics -> visuals -> rider IK -> camera/FX/post -> HUD/audio.
import * as THREE from 'three';
import { buildWorld, WorldData } from './world/heightfield';
import { HeightSampler, TerrainClipmap } from './world/terrain';
import { createTerrainMaterial } from './render/toon';
import { SkySystem } from './render/sky';
import { PostFX, setGlobalTime } from './render/post';
import { Track } from './world/track';
import { FoliageSystem } from './world/foliage';
import { Bike, BikeInput } from './game/bike';
import { buildBike, BikeModel } from './game/models';
import { Rider } from './game/rider';
import { ChaseCam, CamTargetInfo } from './game/camera';
import { DustSystem, BlobShadows, ImpactFX } from './game/effects';
import { HUD } from './game/hud';
import { AudioEngine } from './core/audio';
import { Input } from './core/input';
import { AIController, PERSONALITIES } from './game/ai';
import { Race, Racer } from './game/race';

const PALETTE = {
  grass: 0x86b05c, grassShadow: 0x5d7f8a,
  dirt: 0xa97a48, dirtShadow: 0x77708e,
  rock: 0xa39a90, rockShadow: 0x76718f,
  scree: 0xc0b49b, screeShadow: 0x8d86a0,
  snow: 0xf2ede2, snowShadow: 0xaebdd8,
  trail: 0x93683c, trailShadow: 0x716a8c,
  stream: 0x7d94a0, streamShadow: 0x5d6d8a,
};

interface RacerBundle {
  racer: Racer;
  model: BikeModel;
  rider: Rider;
}

class Game {
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  sampler!: HeightSampler;
  world!: WorldData;
  track!: Track;
  cam!: ChaseCam;
  post!: PostFX;
  hud = new HUD();
  audio = new AudioEngine();
  input = new Input();
  dust!: DustSystem;
  blobs!: BlobShadows;
  impact = new ImpactFX();
  race!: Race;
  bundles: RacerBundle[] = [];
  playerBike!: Bike;
  sky!: SkySystem;

  state: 'loading' | 'menu' | 'countdown' | 'racing' | 'replay' | 'results' = 'loading';
  private timeScale = 1;
  private physAcc = 0;
  private lastT = 0;
  private simTime = 0;
  private frameMsEma = 16;
  private prScale = 1;
  private steerVis = 0;
  private crankAngle = 0;
  private dustAcc = 0;
  private slowmoUsedThisAir = false;
  private replayData: Array<{ p: [number, number, number]; q: [number, number, number, number] }> | null = null;
  private replayT = 0;
  private finishDelay = 0;
  private trickOut = { pose: null as import('./game/bike').TrickPose | null };

  async boot(): Promise<void> {
    const loadFill = document.getElementById('load-fill')!;
    const loadMsg = document.getElementById('load-msg')!;
    this.world = await buildWorld((f, m) => {
      loadFill.style.width = `${(f * 100).toFixed(0)}%`;
      loadMsg.textContent = m;
    });

    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.adaptivePR());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this.renderer.domElement);

    this.sampler = new HeightSampler(this.world);
    this.track = new Track(this.world, this.sampler);

    // ---- world rendering -----------------------------------------------------
    const terrainMat = createTerrainMaterial([
      { col: PALETTE.grass, shadow: PALETTE.grassShadow },
      { col: PALETTE.dirt, shadow: PALETTE.dirtShadow },
      { col: PALETTE.rock, shadow: PALETTE.rockShadow },
      { col: PALETTE.scree, shadow: PALETTE.screeShadow },
      { col: PALETTE.snow, shadow: PALETTE.snowShadow },
      { col: PALETTE.trail, shadow: PALETTE.trailShadow },
      { col: PALETTE.stream, shadow: PALETTE.streamShadow },
    ]);
    const clipmap = new TerrainClipmap(this.sampler, terrainMat);
    this.scene.add(clipmap.group);
    this.clipmapRef = clipmap;

    this.sky = new SkySystem(this.scene);
    this.scene.add(this.track.buildRibbon());
    this.track.buildGates(this.scene);

    const foliage = new FoliageSystem(this.sampler);
    foliage.build(this.world.course.map((c) => new THREE.Vector3(c.x, c.y, c.z)));
    this.scene.add(foliage.group);
    this.foliageRef = foliage;

    // ---- racers -----------------------------------------------------------------
    const kitColors = [
      { frame: 0xe0562e, accents: 0xf2b23a, helmet: 0xf5efe2, kit: 0xe0703c, accent: 0xd8542e },   // player ember
      { frame: 0x2e8c8c, accents: 0xf2e6c8, helmet: 0xf2e6c8, kit: 0x3aa8a8, accent: 0x2e8c8c },   // teal
      { frame: 0xe8c53a, accents: 0x33302e, helmet: 0xf2d43d, kit: 0xd8b23a, accent: 0xc7a13a },   // gold
      { frame: 0x8c5ae0, accents: 0xf2e6c8, helmet: 0xb492ec, kit: 0xa06ae0, accent: 0x9d6ae0 },   // violet
    ];
    this.race = new Race(this.track, this.sampler);
    this.race.buildGhostMesh(this.scene);

    const startP = this.world.course[0];
    const startYaw = Math.atan2(startP.dirX, startP.dirZ);
    const mkRacer = (i: number, name: string, isPlayer: boolean, pers?: import('./game/ai').Personality): RacerBundle => {
      const bike = new Bike(this.sampler, isPlayer);
      const model = buildBike({
        frame: kitColors[i].frame, accents: kitColors[i].accents,
        helmet: kitColors[i].helmet, kit: kitColors[i].kit,
      });
      this.scene.add(model.group);
      const rider = new Rider(model, {
        skin: [0xf2c29b, 0xb9825e, 0xe8ac82, 0x8a5a3c][i],
        kit: kitColors[i].kit, helmet: kitColors[i].helmet, accent: kitColors[i].accent,
      }, this.sampler);
      model.group.add(rider.root);
      const row = Math.floor(i / 2), col = i % 2 === 0 ? -1 : 1;
      const backOff = 5 + row * 3;
      const sx = startP.x - startP.dirX * backOff + (-startP.dirZ) * col * 1.6;
      const sz = startP.z - startP.dirZ * backOff + (startP.dirX) * col * 1.6;
      bike.placeAt(sx, sz, startYaw);
      const racer: Racer = {
        name, bike, isPlayer, colorCss: '#' + kitColors[i].frame.toString(16).padStart(6, '0'),
        progressS: 0, hintIdx: 0, nextCp: 0, finishTime: null, wrongWayT: 0, splitTimes: [],
        lastProgressS: 0, progressStallT: 0,
      };
      if (!isPlayer && pers) racer.ai = new AIController(bike, this.track, pers);
      this.race.addRacer(racer);
      return { racer, model, rider };
    };
    this.bundles.push(mkRacer(0, 'YOU', true));
    this.bundles.push(mkRacer(1, PERSONALITIES[0].name, false, PERSONALITIES[0]));
    this.bundles.push(mkRacer(2, PERSONALITIES[1].name, false, PERSONALITIES[1]));
    this.bundles.push(mkRacer(3, PERSONALITIES[2].name, false, PERSONALITIES[2]));
    this.playerBike = this.bundles[0].racer.bike;
    // showcase autopilot for the demo recorder — clean line, no mistakes
    this.demoAI = new AIController(this.playerBike, this.track, {
      name: 'DEMO', skill: 0.99, aggression: 0.5, mistakeRate: 0, lineWobble: 0.25,
    });

    // ---- fx / camera / post ------------------------------------------------------
    this.dust = new DustSystem(this.scene);
    this.blobs = new BlobShadows(this.scene, 4);
    this.cam = new ChaseCam(window.innerWidth / window.innerHeight);
    this.cam.heightSampler = this.sampler;
    this.post = new PostFX(this.renderer, this.scene, this.cam.camera);
    this.post.registerPrepassExclude(this.sky.group);
    this.post.registerPrepassExclude(this.dust.group);

    // HUD route profile
    const profPts: number[] = [];
    for (let i = 0; i < this.world.course.length; i += 4) profPts.push(this.world.course[i].y);
    this.hud.setProfile(profPts, this.bundles.map((b) => ({
      name: b.racer.name, color: b.racer.colorCss, isPlayer: b.racer.isPlayer,
    })));

    window.addEventListener('resize', () => this.onResize());
    this.setupMenu();

    // initial camera framing on the summit — the film shot
    const sp = this.world.course[0];
    this.cam.snapBehind({
      pos: new THREE.Vector3(sp.x, sp.y + 1, sp.z),
      vel: new THREE.Vector3(), yaw: startYaw,
      speed01: 0, boosting: false, airTime: 0, bigAir: false,
      lookAhead: new THREE.Vector3(sp.x + sp.dirX * 60, sp.y, sp.z + sp.dirZ * 60),
    });
    clipmap.update(sp.x, sp.z);

    this.state = 'menu';
    document.getElementById('loading')!.classList.add('hidden');
    document.getElementById('menu')!.classList.remove('hidden');
    const best = this.race.bestTime;
    if (isFinite(best)) {
      document.getElementById('menu-best')!.textContent =
        `BEST RUN  ${HUD.fmtTime(best)} — your ghost is waiting`;
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  private adaptivePR(): number {
    return Math.min(window.devicePixelRatio || 1, 2) * this.prScale;
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.adaptivePR());
    this.cam.camera.aspect = window.innerWidth / window.innerHeight;
    this.cam.camera.updateProjectionMatrix();
    this.post.setSize(window.innerWidth, window.innerHeight);
  }

  private setupMenu(): void {
    const start = () => {
      this.audio.init();
      document.getElementById('menu')!.classList.add('hidden');
      document.getElementById('results')!.classList.add('hidden');
      this.hud.show();
      this.startRun();
    };
    document.getElementById('btn-start')!.addEventListener('click', start);
    document.getElementById('btn-restart')!.addEventListener('click', start);
    document.getElementById('btn-replay')!.addEventListener('click', () => this.startReplay());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && this.state !== 'loading' && this.state !== 'menu') start();
      if (this.state === 'replay' && e.code === 'Space') this.showResults();
    });
  }

  private startRun(): void {
    const startP = this.world.course[0];
    const startYaw = Math.atan2(startP.dirX, startP.dirZ);
    for (let i = 0; i < this.bundles.length; i++) {
      const b = this.bundles[i];
      const row = Math.floor(i / 2), col = i % 2 === 0 ? -1 : 1;
      const backOff = 5 + row * 3;
      const sx = startP.x - startP.dirX * backOff + (-startP.dirZ) * col * 1.6;
      const sz = startP.z - startP.dirZ * backOff + (startP.dirX) * col * 1.6;
      b.racer.bike.placeAt(sx, sz, startYaw);
      if (b.rider.crashing) b.rider.reattach(b.model);
    }
    this.playerBike.boostMeter = 45;
    this.playerBike.bankScoreReset();
    this.race.start();
    this.slowmoUsedThisAir = false;
    this.state = 'countdown';
  }

  // ---------------------------------------------------------------------------
  private readPlayerInput(): BikeInput {
    const inp = this.input;

    // Demo autopilot (used by tools/record-demo.mjs): the player is driven by
    // an AI controller with showcase behaviour — boost when available, throw
    // a named trick on every decent air.
    if ((window as unknown as { __DEMO_AUTOPILOT?: boolean }).__DEMO_AUTOPILOT && this.demoAI) {
      this.demoAI.update(1 / 60);
      const b = this.playerBike;
      const input = { ...this.demoAI.input };
      input.boost = b.boostMeter > 25;
      input.namedTrick = 0;
      if (!b.onGround && b.airTime > 0.45 && !b.activeTrickName) {
        this.demoTrickIdx = (this.demoTrickIdx % 6) + 1;
        input.namedTrick = this.demoTrickIdx;
      }
      return input;
    }

    return {
      steer: inp.steer,
      pedal: inp.pedal,
      brake: inp.brake,
      crouch: inp.crouchHeld,
      hopPressed: inp.hopPressed,
      boost: inp.boostHeld,
      manual: inp.isDown('Space') && !inp.hopPressed,
      airPitch: (inp.flipB ? 1 : 0) + (inp.flipF ? -1 : 0),
      whipTrigger: inp.whipL || inp.whipR,
      namedTrick: inp.namedTrick(),
    };
  }

  private demoAI: AIController | null = null;
  private demoTrickIdx = 0;

  private stepPhysics(dt: number): void {
    const racing = this.race.state === 'racing';
    const frozen = this.race.state === 'countdown';

    for (const b of this.bundles) {
      let input: BikeInput;
      if (b.racer.ai) {
        b.racer.ai.update(dt);
        input = b.racer.ai.input;
      } else {
        input = frozen || this.state === 'replay'
          ? { ...this.readPlayerInput(), pedal: false, brake: true, steer: 0 }
          : this.readPlayerInput();
      }
      if (!racing && !frozen && this.state !== 'replay') {
        // after finish: gentle auto-brake cruise
        if (b.racer.isPlayer) input = { ...input, brake: true, pedal: false };
      }
      if (frozen) input = AI_NEUTRAL;
      b.racer.bike.update(dt, input);
    }

    if (racing) {
      this.race.resolveCollisions();
      this.race.applyRubberBand();
    }
  }

  // ---------------------------------------------------------------------------
  private applyVisuals(dt: number): void {
    const lookAhead = new THREE.Vector3();
    const playerIdx = this.race.player.hintIdx;
    const lookS = this.race.track.samples[playerIdx].s + 22 + this.playerBike.speed * 0.9;
    this.race.track.posAtS(lookS, lookAhead);

    for (const b of this.bundles) {
      const bike = b.racer.bike;
      const model = b.model;

      model.group.position.set(
        bike.pos.x,
        bike.pos.y - 0.52 + (bike.compF + bike.compR) * 0.06,
        bike.pos.z,
      );
      model.group.quaternion.copy(bike.quaternion);

      // wheels
      const spin = bike.speed / 0.34 * dt;
      model.wheelFront.rotation.x -= spin;
      model.wheelRear.rotation.x -= spin;

      // suspension
      model.forkTravelAnchor.position.y = -0.66 + bike.compF * 0.2;
      model.swingarm.rotation.x = bike.compR * 0.14;
      model.shockSpring.scale.y = 1 - bike.compR * 0.3;

      // steering
      const wantSteer = (b.racer.ai ? b.racer.ai.input.steer : this.input.steer) * 0.45;
      this.steerVis += (wantSteer - this.steerVis) * Math.min(1, dt * 10);
      model.barGroup.rotation.y = this.steerVis;
      model.forkGroup.rotation.y = this.steerVis;

      // crank cadence
      const pedaling = b.racer.ai ? b.racer.ai.input.pedal : this.input.pedal;
      if (bike.onGround && pedaling) {
        this.crankAngle += Math.max(2, bike.speed * 1.15) * dt;
      } else {
        // coasting: cranks settle level
        const target = Math.round(this.crankAngle / Math.PI) * Math.PI;
        this.crankAngle += (target - this.crankAngle) * Math.min(1, dt * 2);
      }
      model.crank.rotation.x = this.crankAngle;

      // trick visual rotations
      const phase = bike.getTrickPhase(this.trickOut);
      let ex = 0, ez = 0, eyaw = 0;
      if (phase >= 0 && this.trickOut.pose) {
        const e = Math.sin(Math.min(phase, 1) * Math.PI);
        ez = (this.trickOut.pose.frameRoll ?? 0) * e;
        eyaw = (this.trickOut.pose.barYaw ?? 0) * e;
        ex = (this.trickOut.pose.frameYaw ?? 0) * e;
      }
      model.frame.rotation.z += (ez - model.frame.rotation.z) * Math.min(1, dt * 12);
      model.frame.rotation.y += (ex - model.frame.rotation.y) * Math.min(1, dt * 12);
      model.barGroup.rotation.y = this.steerVis + eyaw;

      // rider IK solve (after model transforms are updated)
      model.group.updateMatrixWorld(true);
      const trickPoseName = this.trickOut.pose?.pose ?? null;
      const t01 = phase >= 0 ? { pose: trickPoseName, t: phase * (this.trickOut.pose?.duration ?? 1) } : { pose: null, t: 0 };
      const la = b.racer.isPlayer ? lookAhead
        : this.race.track.posAtS(this.race.track.samples[b.racer.hintIdx].s + 24, new THREE.Vector3());
      b.rider.update(bike, model, dt, wantSteer / 0.45, t01, la, pedaling);

      this.blobs.update(this.bundles.indexOf(b), bike.pos, this.sampler, !bike.onGround);

      // ---- dust ------------------------------------------------------------------
      this.dustAcc += dt;
      if (this.dustAcc > 0.03) {
        this.emitRunningDust(b, this.dustAcc);
        this.dustAcc = 0;
      }
      this.processBikeEvents(b);
      b.racer.bike.events.length = 0;
    }

    this.dust.update(dt);
  }

  private emitRunningDust(b: RacerBundle, dt: number): void {
    const bike = b.racer.bike;
    if (!bike.onGround) return;
    const matIdx = DustSystem.matForZone(bike.zone);
    const fast = bike.speed > 9;
    const rate = bike.sliding ? 0.9 : (bike.zone === 3 && fast ? 0.5 : (fast && matIdx === 0 ? 0.28 : 0.1));
    if (Math.random() < rate * dt * 33) {
      this.dust.spawn(bike.wheelWorldR, 0.5, 0.5 + bike.speed * 0.04, matIdx, 0.7);
    }
  }

  private processBikeEvents(b: RacerBundle): void {
    const isPlayer = b.racer.isPlayer;
    for (const ev of b.racer.bike.events) {
      switch (ev.type) {
        case 'land':
          if (ev.power && ev.power > 3) {
            for (let k = 0; k < 4 + ev.power; k++) {
              this.dust.spawn(b.racer.bike.wheelWorldF, 0.8, 0.6 + ev.power * 0.06, DustSystem.matForZone(b.racer.bike.zone), 1.4);
              this.dust.spawn(b.racer.bike.wheelWorldR, 0.8, 0.6 + ev.power * 0.06, DustSystem.matForZone(b.racer.bike.zone), 1.4);
            }
            if (isPlayer) {
              this.impact.trigger(ev.power, false);
              this.cam.shake(Math.min(0.3, ev.power * 0.02));
              this.audio.thump(ev.power);
            }
          }
          break;
        case 'hardLand':
          if (isPlayer) {
            this.impact.trigger(ev.power ?? 12, true);
            this.cam.shake(0.32);
            this.audio.thump(9);
          }
          break;
        case 'crash': {
          for (let k = 0; k < 26; k++) {
            this.dust.spawn(b.racer.bike.pos, 2.4, 1.4, DustSystem.matForZone(b.racer.bike.zone), 1.8);
          }
          b.rider.beginCrash(b.racer.bike);
          if (isPlayer) {
            this.impact.trigger(20, true);
            this.cam.shake(0.55);
            this.audio.crash();
          }
          break;
        }
        case 'recover':
          b.rider.reattach(b.model);
          break;
        case 'hop':
          if (isPlayer) this.audio.thump(2.5);
          break;
        case 'pump':
          this.dust.spawn(b.racer.bike.wheelWorldR, 0.7, 0.5, DustSystem.matForZone(b.racer.bike.zone), 1.2);
          break;
        case 'slide':
          this.dust.spawn(b.racer.bike.wheelWorldR, 0.6, 0.55, DustSystem.matForZone(b.racer.bike.zone), 0.9);
          break;
        case 'trickBanked':
          if (isPlayer) {
            this.hud.trickPopup(`${ev.name}  LANDED`, ev.score);
            this.audio.trickArp();
          }
          break;
        case 'trickFailed':
          if (isPlayer) this.hud.trickPopup('SKETCHY LANDING');
          break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  private consumeRaceEvents(): void {
    for (const ev of this.race.events) {
      switch (ev.type) {
        case 'countdown':
          this.hud.countdown(ev.text);
          this.audio.beep(false);
          break;
        case 'go':
          this.hud.countdown('GO!');
          this.audio.beep(true);
          this.audio.horn();
          this.state = 'racing';
          break;
        case 'checkpoint': {
          const splits = this.race.player.splitTimes;
          const prev = ev.idx > 0 ? splits[ev.idx - 1] : 0;
          this.hud.splitToast(`CHECKPOINT ${ev.idx + 1}  +${(ev.t - prev).toFixed(2)}s`);
          this.audio.ding(ev.idx);
          break;
        }
        case 'finish': {
          this.finishDelay = 0.8;
          break;
        }
        case 'wrongway':
          this.hud.wrongWay(ev.on);
          break;
      }
    }
    this.race.events.length = 0;
  }

  private startReplay(): void {
    const rec = this.playerBike.biggestAirRecord;
    if (!rec || rec.length < 4) { this.showResults(); return; }
    this.replayData = rec;
    this.replayT = 0;
    this.state = 'replay';
    document.getElementById('results')!.classList.add('hidden');
    this.hud.hide();
  }

  private updateReplay(dt: number): void {
    if (!this.replayData) { this.showResults(); return; }
    this.replayT += dt;
    const f = this.replayData;
    const idx = Math.min(f.length - 1, Math.floor(this.replayT / 0.05));
    const fr = f[idx];
    // drive the player's bike mesh from the recording
    const model = this.bundles[0].model;
    model.group.position.set(fr.p[0], fr.p[1] - 0.52, fr.p[2]);
    model.group.quaternion.set(fr.q[0], fr.q[1], fr.q[2], fr.q[3]);
    this.cam.mode = 'orbit';
    this.cam.orbitCenter.set(fr.p[0], fr.p[1], fr.p[2]);
    if (this.replayT / 0.05 > f.length - 1 || this.replayT > 6) this.showResults();
  }

  private showResults(): void {
    this.state = 'results';
    this.cam.mode = 'chase';
    this.hud.hide();
    const st = this.race.standings().map((r) => {
      if (r.finishTime !== null) return r;
      // project unfinished AI riders so the table reads complete
      const clone = { ...r } as Racer;
      const remaining = this.race.track.length - r.progressS;
      clone.finishTime = this.race.time + remaining / Math.max(9, r.bike.speed);
      return clone;
    });
    st.sort((a, b) => (a.finishTime ?? 1e9) - (b.finishTime ?? 1e9));
    const ord = st.findIndex((r) => r.isPlayer) + 1;
    const headline = document.getElementById('res-headline')!;
    const medals = ['YOU WIN!', '2ND PLACE', '3RD PLACE', '4TH PLACE'];
    headline.textContent = ord === 1 && st.length === 4 ? medals[0] : medals[Math.min(ord, 4) - 1];

    const table = document.getElementById('res-table')!;
    table.innerHTML =
      '<tr><th></th><th>RIDER</th><th>TIME</th><th>GAP</th></tr>' +
      st.map((r, i) => {
        const t = r.finishTime ?? null;
        const gap = t !== null && st[0].finishTime !== null ? `+${(t - st[0].finishTime!).toFixed(2)}` : '—';
        return `<tr class="${r.isPlayer ? 'me' : ''}">
          <td>${i + 1}</td><td>${r.name}</td>
          <td>${t !== null ? HUD.fmtTime(t) : 'DNF'}</td><td>${gap}</td></tr>`;
      }).join('');

    const tricks = document.getElementById('res-tricks')!;
    tricks.textContent =
      `TRICK SCORE ${this.playerBike.runTrickTotal}   ·   BIGGEST AIR ${this.playerBike.biggestAirHeight.toFixed(1)}m` +
      (this.race.maybeSaveGhost() ? '   ·   NEW BEST — GHOST SAVED' : '');
    document.getElementById('results')!.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    if (!this.lastT) this.lastT = now;
    // In deterministic capture mode the rAF loop idles; the recorder advances
    // the simulation one fixed frame at a time via stepDemoFrame().
    if ((window as unknown as { __DEMO_FIXED_STEP?: boolean }).__DEMO_FIXED_STEP) return;
    const rawDt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.tick(rawDt);
  }

  /** advance the whole game by exactly one fixed frame (demo recorder) */
  stepDemoFrame(): void {
    this.tick(1 / 30);
  }

  private tick(rawDt: number): void {
    const fixed = (window as unknown as { __DEMO_FIXED_STEP?: boolean }).__DEMO_FIXED_STEP === true;

    // adaptive pixel ratio (skipped in deterministic capture — quality locked)
    if (!fixed) {
      this.frameMsEma = this.frameMsEma * 0.95 + (rawDt * 1000) * 0.05;
      if (this.frameMsEma > 17.8 && this.prScale > 0.62) {
        this.prScale = Math.max(0.62, this.prScale - 0.12);
        this.onResize();
        this.frameMsEma = 16;
      } else if (this.frameMsEma < 12.5 && this.prScale < 1) {
        this.prScale = Math.min(1, this.prScale + 0.08);
        this.onResize();
        this.frameMsEma = 16;
      }
    }

    this.input.sample(rawDt);
    this.consumeRaceEvents();

    // demo mode: slow cinematic orbit around the grid during the countdown,
    // then snap into the chase rig when the horn blows
    const demo = (window as unknown as { __DEMO_AUTOPILOT?: boolean }).__DEMO_AUTOPILOT === true;
    if (demo && this.state === 'countdown') {
      this.cam.mode = 'orbit';
      this.cam.orbitSpeed = 0.22;
      this.cam.orbitCenter.copy(this.playerBike.pos).add(new THREE.Vector3(0, 1.2, 0));
    } else if (this.cam.mode === 'orbit' && this.state === 'racing' && !this.replayData) {
      this.cam.mode = 'chase';
      this.cam.snapBehind({
        pos: this.playerBike.pos, vel: this.playerBike.vel, yaw: this.playerBike.yaw,
        speed01: 0, boosting: false, airTime: 0, bigAir: false,
        lookAhead: this.camLookTmp,
      });
    }

    // slow-mo on the biggest jumps + hitstop from impacts
    let ts = 1;
    if (this.state === 'racing') {
      const pb = this.playerBike;
      if (!pb.onGround && pb.airTime > 0.75 && !this.slowmoUsedThisAir && pb.biggestAirPending()) {
        this.slowmoUsedThisAir = true;
        this.slowmoTimer = 0.65;
      }
      if (this.slowmoTimer > 0) { this.slowmoTimer -= rawDt; ts = 0.55; }
    }
    if (this.impact.hitstopTimer > 0) ts *= 0.08;
    this.timeScale += (ts - this.timeScale) * Math.min(1, rawDt * 20);

    const dt = rawDt * this.timeScale;

    // fixed-step physics (frozen during the cinematic replay)
    if (this.state !== 'menu' && this.state !== 'replay') {
      this.physAcc += dt;
      const h = 1 / 120;
      let guard = 0;
      while (this.physAcc >= h && guard++ < 6) {
        this.stepPhysics(h);
        this.physAcc -= h;
        this.race.update(h);
      }
    }

    if (this.state === 'replay') {
      this.updateReplay(rawDt);
    } else {
      this.applyVisuals(dt);
    }

    // finish sequencing
    if (this.finishDelay > 0) {
      this.finishDelay -= rawDt;
      if (this.finishDelay <= 0) this.startReplay();
    }

    // camera
    const pb = this.playerBike;

    // player self-rescue: T teleports back onto the racing line (small cost:
    // you keep your position on the mountain but lose all your speed)
    if (this.input.rescuePressed && this.state === 'racing' && !pb.crashed) {
      const trk = this.race.track;
      const idx = Math.min(trk.samples.length - 1, this.race.player.hintIdx + 4);
      const sm = trk.samples[idx];
      pb.placeAt(sm.p.x, sm.p.z, Math.atan2(sm.t.x, sm.t.z));
      pb.vel.set(sm.t.x * 5, 0, sm.t.z * 5);
      this.hud.splitToast('BACK ON COURSE');
    }
    const info: CamTargetInfo = {
      pos: pb.pos,
      vel: pb.vel,
      yaw: pb.yaw,
      speed01: Math.min(1, pb.speed / 26),
      boosting: pb.boosting,
      airTime: pb.airTime,
      bigAir: pb.airTime > 0.7,
      lookAhead: this.camLookTmp,
    };
    const lookS = this.race.track.samples[this.race.player.hintIdx].s + 26 + pb.speed * 0.9;
    this.race.track.posAtS(lookS, this.camLookTmp);
    this.cam.update(rawDt, info, this.slowmoTimer > 0);
    this.sky.update(this.cam.camera, rawDt);

    // world streaming + foliage
    this.clipmapRef?.update(pb.pos.x, pb.pos.z);
    this.foliageRef?.update(this.cam.camera.position.x, this.cam.camera.position.z);
    this.race.updateGhost(rawDt, this.race.time);

    // impact decay
    this.impact.update(rawDt);
    this.post.speed01 = info.speed01;
    this.post.boost01 = pb.boosting ? 1 : Math.max(0, this.post.boost01 - rawDt * 2);
    this.post.flash = this.impact.flash;
    this.post.whiteFlash = this.impact.whiteFlash;
    this.post.desat = this.impact.desat;
    this.post.vanishPoint.set(0.5, 0.42);

    // HUD
    if (this.state === 'racing' || this.state === 'countdown') {
      this.hud.setSpeed(pb.speedKmh);
      this.hud.setPos(this.race.playerOrdinal());
      this.hud.setTimer(this.race.time);
      this.hud.setBoost(pb.boostMeter / 100);
      for (let i = 0; i < this.bundles.length; i++) {
        this.hud.setProgress(i, this.bundles[i].racer.progressS / this.race.track.length);
      }
      const curv = this.race.track.curvatureAhead(this.race.player.hintIdx, 55);
      this.hud.cornerHint(pb.onGround ? curv : null);
      this.hud.airTime(pb.onGround ? null : pb.airTime, Math.max(0, pb.airTime * pb.airTime * 11.5));
      this.hud.frame(rawDt);
    }

    // audio
    if (this.state === 'racing') {
      this.audio.update(
        pb.speed, pb.zone,
        this.input.pedal, !this.input.pedal && pb.speed > 2,
        pb.boosting, rawDt,
      );
    }

    this.simTime += rawDt;
    setGlobalTime(this.simTime);
    this.post.render();
    this.input.endFrame();
  }

  private camLookTmp = new THREE.Vector3();
  private slowmoTimer = 0;
  private clipmapRef: TerrainClipmap | null = null;
  private foliageRef: FoliageSystem | null = null;
}

const AI_NEUTRAL: BikeInput = {
  steer: 0, pedal: false, brake: true, crouch: false, hopPressed: false,
  boost: false, manual: false, airPitch: 0, whipTrigger: false, namedTrick: 0,
};

const game = new Game();
(window as unknown as { __game: Game }).__game = game;
game.boot().catch((err) => {
  console.error(err);
  const msg = document.getElementById('load-msg')!;
  msg.textContent = 'failed to build the mountain: ' + err.message;
});
