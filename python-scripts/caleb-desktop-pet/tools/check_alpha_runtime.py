from pathlib import Path
import sys
import tkinter as tk
from PIL import ImageGrab
BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/'app'))
import main
main.CalebPet._start_tray_icon=lambda self:None
main.MicSampler.sample=lambda self:0
root=tk.Tk()
app=main.CalebPet(root, welcome=False)
app.auto_var.set(False)
root.geometry('192x208+300+300')
root.update()
app.paused=True
try:
    for state,frames in app.frames.items():
        for frame in frames:
            app.alpha_window.render(frame)
            root.update()
    for frame in app.look_frames:
        app.alpha_window.render(frame)
        root.update()
    app.state='jumping'; app.frame=3; app._render(); root.update()
    root.after(400,root.quit); root.mainloop()
    ImageGrab.grab(bbox=(300,300,492,508)).save(BASE/'qa-restored'/'runtime.png')
    app.show_reminder('water',force=True); root.update()
    canvas=app.bubble.winfo_children()[0]
    assert any(canvas.itemcget(i,'text')=='小小补水提醒' for i in canvas.find_all() if canvas.type(i)=='text')
    app._answer_reminder('ack'); root.update()
    print('PASS:', sum(len(frames) for frames in app.frames.values()), 'animation frames + 16 look directions, native alpha upload, reminder text and callback')
finally:
    app.quit()
