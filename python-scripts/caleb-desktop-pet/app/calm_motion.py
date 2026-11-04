"""Low-distraction timing and gaze continuity; never deform character artwork."""
import random


class CalmMotion:
    def __init__(self):
        self.variant = -1
        self.index = 0
        self.deadline = 0.0
        self.active = False
        self.gaze = None
        self.gaze_step_at = 0.0
        self.was_looking = False
        self.frames = []

    def reset(self, now):
        self.variant = random.choice([v for v in range(3) if v != self.variant])
        # Preserve the source pose order; vary the breathing/blink pacing and
        # resting beats instead of inventing backwards anatomy or new poses.
        gestures = (
            [240, 220, 320, 340, 480],
            [180, 200, 460, 480, 620],
            [300, 260, 360, 400, 560],
        )
        self.frames = [random.uniform(4500, 6500)] + gestures[self.variant]
        self.index = 0
        self.deadline = now + self.frames[0] / 1000
        self.active = True

    def idle_frame(self, now):
        if not self.active:
            self.reset(now)
        if now >= self.deadline:
            self.index += 1
            if self.index == 6:
                self.reset(now)
            else:
                self.deadline = now + self.frames[self.index] / 1000
        return self.index

    def look_frame(self, target, now):
        if self.gaze is None:
            self.gaze = target
            self.gaze_step_at = now + .18
        elif now >= self.gaze_step_at:
            delta = (target - self.gaze + 8) % 16 - 8
            if delta:
                self.gaze = (self.gaze + (1 if delta > 0 else -1)) % 16
            self.gaze_step_at = now + .18
        return self.gaze
