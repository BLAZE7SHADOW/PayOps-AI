"""Assemble the narrated product walkthrough from actual clips and illustrative cards."""
import json, os, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[2]
work = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/payops-video-v2')
out = root / os.environ.get('DEMO_OUT', 'docs/demo')
out.mkdir(parents=True, exist_ok=True)
def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
def stamp(t):
    ms = round(t * 1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
def srt(cues):
    return '\n\n'.join(f"{i+1}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i, c in enumerate(cues)) + '\n'
scenes = json.loads((work/'timing.json').read_text())
clips = {clip['id']: clip for clip in json.loads((work/'clips.json').read_text())}
# The reveal precedes the overview; the diagram is followed by the actual selected specialists.
# Chrome screencast may leave an unpainted strip on document-only cards. Repaint only
# that presentation footer, using the same labels as the source card; never alter app footage.
footers = {
    'intro': 'A PAYMENT OPERATIONS PROBLEM',
    'reveal': 'PAYOPS AI / PRODUCT WALKTHROUGH',
    'architecture': 'PAYOPS AI / PRODUCT WALKTHROUGH',
    'engineering': 'PAYOPS AI / PRODUCT WALKTHROUGH',
    'outro': 'SIMULATED PAYMENTS / REPLAYED MODEL RESPONSES',
}
def card_footer(clip_id):
    if clip_id not in footers:
        return ''
    label = work/f'{clip_id}-footer.txt'
    label.write_text(footers[clip_id])
    return (f"drawbox=x=0:y=800:w=1600:h=100:color=0xF5F2EA:t=fill,"
            f"drawbox=x=100:y=814:w=1400:h=1:color=0xB8C3BB:t=fill,"
            f"drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:textfile='{label}':fontsize=17:fontcolor=0x52625A:x=100:y=837,")
def combine(scene, parts):
    listing = []
    for index, (clip_id, limit) in enumerate(parts):
        clip = clips[clip_id]
        length = min(clip['end']-clip['start'], limit)
        target = work/f'{scene}-part-{index}.mp4'
        run(['ffmpeg','-y','-v','error','-ss',str(clip['start']),'-i',clip['file'],'-an','-vf',card_footer(clip_id)+'setpts=PTS-STARTPTS,fps=30','-t',str(length),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',str(target)])
        listing.append(f"file '{target}'\n")
    manifest = work/f'{scene}-parts.txt'
    manifest.write_text(''.join(listing))
    merged = work/f'{scene}-merged.mp4'
    run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(manifest),'-c','copy',str(merged)])
    length = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(merged)]))
    clips[scene] = {'file':str(merged),'start':0,'end':length}
combine('overview', [('reveal',5.5),('overview',10)])
combine('architecture', [('architecture',5.5),('agents',30)])
all_cues, manifest, chapters = [], [], []
offset = 0
for index, scene in enumerate(scenes):
    clip = clips[scene['id']]
    duration = scene['duration']
    subtitle = work/f"{scene['id']}.srt"
    subtitle.write_text(srt(scene['cues']))
    title = work/f"{scene['id']}-title.txt"
    title.write_text(f"{index+1:02} / {scene['title']}")
    filters = (
        card_footer(scene['id']) if scene['id'] in ['intro','engineering','outro'] else ''
    ) + (
        f"trim=duration={clip['end']-clip['start']},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=60,"
        f"scale=1706:960,pad=1920:1080:107:60:color=0xF5F2EA,setsar=1,fps=30,"
        f"drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:textfile='{title}':fontsize=26:fontcolor=0x1E5A4C:x=107:y=18,"
        f"subtitles='{subtitle}':force_style='FontName=Arial,FontSize=9,PrimaryColour=&H00202C28,Outline=0,Shadow=0,MarginV=5,Alignment=2'"
    )
    target = work/f"final-{scene['id']}.mp4"
    run(['ffmpeg','-y','-v','error','-ss',str(clip['start']),'-i',clip['file'],'-i',str(work/f"{scene['id']}.wav"),'-vf',filters,'-t',str(duration),'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',str(target)])
    manifest.append(f"file '{target}'\n")
    all_cues.extend({**cue,'start':cue['start']+offset,'end':cue['end']+offset} for cue in scene['cues'])
    scene['globalStart'] = offset
    chapters.append(f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={round(offset*1000)}\nEND={round((offset+duration)*1000)}\ntitle={scene['title']}\n")
    offset += duration
    print('Rendered',scene['id'],flush=True)
(work/'final-list.txt').write_text(''.join(manifest))
metadata = work/'chapters.txt'
metadata.write_text(';FFMETADATA1\ntitle=PayOps AI product walkthrough\n'+''.join(chapters))
run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(work/'final-list.txt'),'-i',str(metadata),'-map_metadata','1','-map_chapters','1','-c','copy','-movflags','+faststart',str(out/'payops-demo.mp4')])
run(['ffmpeg','-y','-v','error','-i',str(out/'payops-demo.mp4'),'-vn','-map_metadata','-1','-c:a','copy',str(out/'narration.m4a')])
(out/'payops-demo.srt').write_text(srt(all_cues))
(out/'transcript.md').write_text('# PayOps AI demo transcript\n\nFemale neural narration. Simulated payment data; model responses replayed.\n\n'+'\n\n'.join(f"## {int(s['globalStart'])//60}:{int(s['globalStart'])%60:02} · {s['title']}\n\n"+' '.join(s['lines']) for s in scenes)+'\n')
# Poster comes from the product reveal rather than the opening problem.
poster_at = next(s['globalStart']+1 for s in scenes if s['id']=='overview')
run(['ffmpeg','-y','-v','error','-ss',str(poster_at),'-i',str(out/'payops-demo.mp4'),'-frames:v','1','-q:v','2',str(out/'poster.jpg')])
print('Finished',round(offset,1),'seconds')
