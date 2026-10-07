"""Generate precisely timed narration cues with macOS say and FFmpeg (no Python dependencies)."""
import json, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[2]
work = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/payops-video')
work.mkdir(parents=True, exist_ok=True)
scenes = json.loads((root/'docs/demo/storyboard.json').read_text())
voice = sys.argv[2] if len(sys.argv)>2 else 'Samantha'
def run(args): subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
def duration(path): return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(path)]))
for scene in scenes:
    cues=[]; pos=.4; parts=[]
    for index,line in enumerate(scene['lines']):
        stem=work/f"{scene['id']}-{index}"
        stem.with_suffix('.txt').write_text(line)
        run(['say','-v',voice,'-r','157','-f',str(stem.with_suffix('.txt')),'-o',str(stem.with_suffix('.aiff'))])
        length=duration(stem.with_suffix('.aiff'))
        run(['ffmpeg','-y','-v','error','-i',str(stem.with_suffix('.aiff')),'-af','apad=pad_dur=0.35','-ar','48000','-ac','1',str(stem.with_suffix('.wav'))])
        # Captions are short phrases, synchronized proportionally within each spoken sentence.
        words=line.split(); chunks=[]
        while words: chunks.append(words[:10]);words=words[10:]
        total=sum(len(c) for c in chunks); offset=pos
        for c in chunks:
            end=offset+length*len(c)/total;cues.append({'start':offset,'end':end,'text':' '.join(c)});offset=end
        pos+=length+.35;parts.append(stem.with_suffix('.wav'))
    listing=work/f"{scene['id']}-audio.txt"; listing.write_text(''.join(f"file '{p}'\n" for p in parts))
    wav=work/f"{scene['id']}.wav"
    run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(listing),'-af','adelay=400,apad=pad_dur=0.8,loudnorm=I=-16:TP=-1.5:LRA=11','-ar','48000',str(wav)])
    scene.update(duration=duration(wav),cues=cues)
    print(scene['id'],round(scene['duration'],2),flush=True)
(work/'timing.json').write_text(json.dumps(scenes,indent=2))
print('Total seconds:',round(sum(s['duration'] for s in scenes),1))
