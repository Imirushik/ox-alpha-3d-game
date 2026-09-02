// Keyboard input with edge detection (justPressed) and analog-ish smoothing.
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();

  steer = 0;        // -1..1 smoothed
  private steerTarget = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressedThisFrame.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string): boolean { return this.down.has(code); }
  justPressed(code: string): boolean { return this.pressedThisFrame.has(code); }

  /** Call at end of frame */
  endFrame() { this.pressedThisFrame.clear(); }

  /** Per-frame semantic state consumed by gameplay */
  sample(dt: number) {
    let target = 0;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) target -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) target += 1;
    // fast attack, slightly slower release — feels like leaning a bike
    const rate = Math.abs(target) > Math.abs(this.steer) ? 9 : 6;
    this.steer += (target - this.steer) * Math.min(1, rate * dt);
    if (Math.abs(this.steer) < 0.01 && target === 0) this.steer = 0;
    this.steerTarget = target;
  }

  get pedal() { return this.isDown('KeyW') || this.isDown('ArrowUp'); }
  get brake() { return this.isDown('KeyS') || this.isDown('ArrowDown'); }
  get crouchHeld() { return this.isDown('KeyS') || this.isDown('ControlLeft'); }
  get hopPressed() { return this.justPressed('Space'); }
  get boostHeld() { return this.isDown('ShiftLeft') || this.isDown('ShiftRight'); }

  // Air trick inputs
  get spinL() { return this.isDown('KeyA') || this.isDown('ArrowLeft'); }
  get spinR() { return this.isDown('KeyD') || this.isDown('ArrowRight'); }
  get flipF() { return this.isDown('KeyW') || this.isDown('ArrowUp'); }
  get flipB() { return this.isDown('KeyS') || this.isDown('ArrowDown'); }
  get whipL() { return this.justPressed('KeyQ'); }
  get whipR() { return this.justPressed('KeyE'); }
  namedTrick(): number {
    for (let i = 1; i <= 6; i++) if (this.justPressed('Digit' + i)) return i;
    return 0;
  }
  get rescuePressed() { return this.justPressed('KeyT'); }
}
