"""Re-extract original generated strips; preserve solid interiors and soft alpha."""
from pathlib import Path
import json
import numpy as np
from scipy import ndimage as ndi
from PIL import Image

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE.parent / 'caleb-corrected-run' / 'decoded'
OUT = BASE / 'qa-restored'
ROWS = [('idle',6),('running-right',8),('running-left',8),('waving',4),('jumping',5),('failed',8),('waiting',6),('running',6),('review',6),('look-row-9',8),('look-row-10',8)]

def extract(path, count):
    rgb = np.array(Image.open(path).convert('RGB')).astype(np.float32)
    key = np.median(np.concatenate([rgb[:8].reshape(-1,3),rgb[-8:].reshape(-1,3)]),axis=0)
    distance = np.linalg.norm(rgb-key,axis=2)
    bg = distance < 35
    # Classify the narrow mixed boundary against nearby solid character RGB.
    solid = distance > 135
    _, near = ndi.distance_transform_edt(~solid, return_indices=True)
    fg = rgb[tuple(near)]
    delta = fg-key
    alpha = np.clip(np.sum((rgb-key)*delta,axis=2)/np.maximum(np.sum(delta*delta,axis=2),1),0,1)
    alpha[solid] = 1
    alpha[bg] = 0
    labels,n = ndi.label(alpha > .1)
    sizes = np.bincount(labels.ravel()); sizes[0]=0
    ids = np.argsort(sizes)[-count:]
    if len(ids)!=count or min(sizes[ids]) < 1000:
        raise ValueError(f'Cannot identify {count} complete poses: {path}')
    ids = sorted(ids,key=lambda i:np.where(labels==i)[1].mean())
    # Recover foreground color only in the mixed band. Solid pixels are exact.
    clean = np.clip((rgb-(1-alpha[...,None])*key)/np.maximum(alpha[...,None],.02),0,255)
    clean[solid]=rgb[solid]
    rgba=np.dstack([clean,np.round(alpha*255)]).astype('uint8')
    rgba[alpha==0]=0
    poses=[]
    _, owner_index=ndi.distance_transform_edt(labels==0,return_indices=True)
    owner=labels[tuple(owner_index)]
    for ident in ids:
        yy,xx=np.where(labels==ident)
        box=(max(0,xx.min()-3),max(0,yy.min()-3),min(rgb.shape[1],xx.max()+4),min(rgb.shape[0],yy.max()+4))
        x1,y1,x2,y2=box
        cropped=rgba[y1:y2,x1:x2].copy()
        cropped[owner[y1:y2,x1:x2]!=ident]=0
        poses.append((Image.fromarray(cropped),box))
    return poses

def main():
    OUT.mkdir(exist_ok=True)
    atlas=Image.new('RGBA',(1536,2288))
    report=[]
    for row,(name,count) in enumerate(ROWS):
        poses=extract(SOURCE/(name+'.png'),count)
        # One scale per row; jump keeps its source vertical displacement.
        scale=min(174/max(p.width for p,b in poses),188/max(p.height for p,b in poses))
        if name=='jumping':
            scale=min(scale,188/(max(b[3] for p,b in poses)-min(b[1] for p,b in poses)))
        bottom=max(b[3] for p,b in poses)
        cells=[]
        for col,(pose,box) in enumerate(poses):
            scaled=pose.resize((round(pose.width*scale),round(pose.height*scale)),Image.Resampling.LANCZOS)
            cell=Image.new('RGBA',(192,208))
            y=200-scaled.height
            if name=='jumping': y-=round((bottom-box[3])*scale)
            cell.alpha_composite(scaled,((192-scaled.width)//2,y))
            atlas.alpha_composite(cell,(col*192,row*208)); cells.append(cell)
        report.append({'row':name,'count':len(cells),'scale':scale,'source':str(SOURCE/(name+'.png'))})
        # Full-color animated WebP preserves alpha unlike GIF.
        cells[0].save(OUT/(name+'.webp'),save_all=True,append_images=cells[1:],duration=220,loop=0,lossless=True)
    # v2 reserves idle column 6 for the neutral pointer-deadzone pose.
    atlas.alpha_composite(atlas.crop((0,0,192,208)),(6*192,0))
    a=np.array(atlas); a[a[:,:,3]==0]=0; atlas=Image.fromarray(a)
    atlas.save(OUT/'spritesheet.png')
    for color in ['white','#101827']:
        bg=Image.new('RGBA',atlas.size,color); bg.alpha_composite(atlas)
        bg.convert('RGB').save(OUT/('white.png' if color=='white' else 'dark.png'))
    (OUT/'provenance.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('Restored',sum(r['count'] for r in report),'poses from original strips')

if __name__=='__main__': main()
