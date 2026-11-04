"""Native Windows per-pixel alpha; no color-key background compositing."""
import ctypes as c
from ctypes import wintypes as w

class BitmapInfo(c.Structure):
    _fields_=[('size',w.DWORD),('width',w.LONG),('height',w.LONG),('planes',w.WORD),('bits',w.WORD),('compression',w.DWORD),('image_size',w.DWORD),('xppm',w.LONG),('yppm',w.LONG),('used',w.DWORD),('important',w.DWORD)]

class Blend(c.Structure):
    _fields_=[('op',c.c_ubyte),('flags',c.c_ubyte),('alpha',c.c_ubyte),('format',c.c_ubyte)]

class AlphaWindow:
    def __init__(self,root):
        self.root=root
        self.u=c.windll.user32; self.g=c.windll.gdi32
        self.u.GetParent.argtypes=[w.HWND]; self.u.GetParent.restype=w.HWND
        self.u.GetDC.argtypes=[w.HWND]; self.u.GetDC.restype=w.HDC
        self.g.CreateCompatibleDC.argtypes=[w.HDC]; self.g.CreateCompatibleDC.restype=w.HDC
        self.g.CreateDIBSection.argtypes=[w.HDC,c.POINTER(BitmapInfo),w.UINT,c.POINTER(c.c_void_p),w.HANDLE,w.DWORD]; self.g.CreateDIBSection.restype=w.HBITMAP
        self.g.SelectObject.argtypes=[w.HDC,w.HANDLE]; self.g.SelectObject.restype=w.HANDLE
        self.g.DeleteObject.argtypes=[w.HANDLE]; self.g.DeleteDC.argtypes=[w.HDC]
        self.u.ReleaseDC.argtypes=[w.HWND,w.HDC]
        self.u.GetWindowLongW.argtypes=[w.HWND,c.c_int]; self.u.SetWindowLongW.argtypes=[w.HWND,c.c_int,w.LONG]
        self.u.UpdateLayeredWindow.argtypes=[w.HWND,w.HDC,c.POINTER(w.POINT),c.POINTER(w.SIZE),w.HDC,c.POINTER(w.POINT),w.DWORD,c.POINTER(Blend),w.DWORD]
        root.update_idletasks()
        self.hwnd=self.u.GetParent(root.winfo_id()) or root.winfo_id()
        style=self.u.GetWindowLongW(self.hwnd,-20)
        self.u.SetWindowLongW(self.hwnd,-20,style|0x80000)
        self.last=None
        self.cache={}

    def render(self,image):
        if image is self.last: return
        key=id(image)
        if key not in self.cache:
            # Premultiplied BGRA is required by AC_SRC_ALPHA.
            data=bytearray(image.tobytes())
            for i in range(0,len(data),4):
                r,g,b,a=data[i:i+4]
                data[i:i+4]=bytes(((b*a+127)//255,(g*a+127)//255,(r*a+127)//255,a))
            self.cache[key]=bytes(data)
        width,height=image.size
        screen=self.u.GetDC(None); dc=self.g.CreateCompatibleDC(screen)
        info=BitmapInfo(c.sizeof(BitmapInfo),width,-height,1,32,0,width*height*4,0,0,0,0)
        bits=c.c_void_p(); bitmap=self.g.CreateDIBSection(dc,c.byref(info),0,c.byref(bits),None,0)
        old=self.g.SelectObject(dc,bitmap)
        try:
            data=self.cache[key]; c.memmove(bits,data,len(data))
            size=w.SIZE(width,height); origin=w.POINT(0,0); blend=Blend(0,0,255,1)
            if not self.u.UpdateLayeredWindow(self.hwnd,screen,None,c.byref(size),dc,c.byref(origin),0,c.byref(blend),2):
                raise c.WinError()
            self.last=image
        finally:
            self.g.SelectObject(dc,old); self.g.DeleteObject(bitmap); self.g.DeleteDC(dc); self.u.ReleaseDC(None,screen)
