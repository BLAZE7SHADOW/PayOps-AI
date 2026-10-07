"""Assemble recorded clips, synthetic narration and timed captions into a GitHub-sized MP4."""
import json, pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parents[2]
work=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/private/tmp/payops-video')
import os
out=root/os.environ.get('DEMO_OUT','docs/demo');out.mkdir(parents=True,exist_ok=True)
def run(args):subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
def stamp(t):
    ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
def srt(cues):return '\n\n'.join(f"{i+1}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i,c in enumerate(cues))+'\n'
scenes=json.loads((work/'timing.json').read_text());clips={s['id']:s for s in json.loads((work/'clips.json').read_text())}
marks=json.loads((work/'marks.json').read_text());raw=(work/'raw-path.txt').read_text()
for i,mark in enumerate(marks[:-1]):clips[mark['id']]={**mark,'file':raw,'end':marks[i+1]['start']}
# Combine the illustrative architecture with the actual recorded run.
agents=json.loads((work/'agents-clip.json').read_text())
for name,clip,dur in [('arch-card',clips['architecture'],7),('arch-run',agents,13.5)]:
    run(['ffmpeg','-y','-v','error','-ss',str(clip['start']),'-i',clip['file'],'-an','-vf',f"tpad=stop_mode=clone:stop_duration=30,fps=30",'-t',str(dur),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',str(work/f'{name}.mp4')])
(work/'arch-list.txt').write_text("file 'arch-card.mp4'\nfile 'arch-run.mp4'\n")
run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(work/'arch-list.txt'),'-c','copy',str(work/'architecture.mp4')])
clips['architecture']={'file':str(work/'architecture.mp4'),'start':0,'end':20.5}
all_cues=[];offset=0;manifest=[]
for index,scene in enumerate(scenes):
    clip=clips[scene['id']];duration=scene['duration'];subtitle=work/f"{scene['id']}.srt";subtitle.write_text(srt(scene['cues']))
    title=work/f"{scene['id']}-title.txt";title.write_text(f"{index+1:02} / {scene['title']}")
    # The app sits inside a 1080p presentation frame. Captions occupy their own footer.
    filters=(f"trim=duration={clip['end']-clip['start']},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=60,"
        f"scale=1706:960,pad=1920:1080:107:60:color=0xF5F2EA,setsar=1,fps=30,"
        f"drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:textfile='{title}':fontsize=26:fontcolor=0x1E5A4C:x=107:y=18,"
        f"subtitles='{subtitle}':force_style='FontName=Arial,FontSize=9,PrimaryColour=&H00202C28,Outline=0,Shadow=0,MarginV=5,Alignment=2'")
    target=work/f"final-{scene['id']}.mp4"
    run(['ffmpeg','-y','-v','error','-ss',str(clip['start']),'-i',clip['file'],'-i',str(work/f"{scene['id']}.wav"),'-vf',filters,'-t',str(duration),'-c:v','libx264','-preset','fast','-crf','25','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-movflags','+faststart',str(target)])
    manifest.append(f"file '{target}'\n")
    all_cues.extend({**c,'start':c['start']+offset,'end':c['end']+offset} for c in scene['cues']);scene['globalStart']=offset;offset+=duration
    print('rendered',scene['id'],flush=True)
(work/'final-list.txt').write_text(''.join(manifest))
run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(work/'final-list.txt'),'-c','copy','-movflags','+faststart',str(out/'payops-demo.mp4')])
run(['ffmpeg','-y','-v','error','-i',str(out/'payops-demo.mp4'),'-vn','-c:a','copy',str(out/'narration.m4a')])
(out/'payops-demo.srt').write_text(srt(all_cues))
(out/'transcript.md').write_text('# PayOps AI demo transcript\n\nSynthetic English narration. Simulated payment data; model responses replayed.\n\n'+ '\n\n'.join(f"## {int(s['globalStart'])//60}:{int(s['globalStart'])%60:02} · {s['title']}\n\n"+' '.join(s['lines']) for s in scenes)+'\n')
run(['ffmpeg','-y','-v','error','-ss','1','-i',str(out/'payops-demo.mp4'),'-frames:v','1','-q:v','2',str(out/'poster.jpg')])
print('Finished',round(offset,1),'seconds')
