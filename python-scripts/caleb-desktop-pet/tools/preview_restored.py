from pathlib import Path
from PIL import Image,ImageDraw
base=Path(__file__).resolve().parents[1]
sheet=Image.open(base/'assets/spritesheet.png').convert('RGBA')
out=Image.new('RGB',(768,464),'white')
draw=ImageDraw.Draw(out)
for row,(r,c) in enumerate([(4,3),(1,0)]):
    frame=sheet.crop((c*192,r*208,(c+1)*192,(r+1)*208))
    for col,color in enumerate(['white','#101827']):
        tile=Image.new('RGBA',(384,208),color)
        tile.alpha_composite(frame,(96,0))
        out.paste(tile.convert('RGB'),(col*384,row*232+24))
draw.text((15,5),'Restored original poses / White and dark backgrounds',fill='black')
out.save(base/'qa-restored/preview.png')
for color,name in [('white','white'),('#101827','dark')]:
    bg=Image.new('RGBA',sheet.size,color); bg.alpha_composite(sheet)
    bg.convert('RGB').save(base/f'qa-restored/{name}.png')
