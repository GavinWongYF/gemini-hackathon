"""python -m eval.real_game.analyse LOGS_DIR STREAMS_DIR

Reads the match logs written by live_match.mts and the server's recordings
of the same matches (`--record`, in data/streams/), and prints the Round 1
numbers: shares per arm, errors, the short loop, local picks, the larger
loop, the fairness dial, token use, and how alike the final behaviours are.
"""

from __future__ import annotations

import collections
import glob
import json
import os
import statistics as st
import sys


def rows(p):
    return [json.loads(line) for line in open(p) if line.strip()]


def pct(x):
    return '-' if x is None else f"{round(100 * x)}%"


def med(xs):
    return round(st.median(xs), 1) if xs else None


def p90(xs):
    return round(sorted(xs)[int(0.9 * (len(xs) - 1))], 1) if xs else None


def analyse(logs_dir: str, streams_dir: str) -> None:
    matches=[]
    for p in sorted(glob.glob(os.path.join(logs_dir,'real_*.jsonl'))):
        r=rows(p); name=os.path.basename(p)[:-6]
        arm='adapt' if '_adapt_' in name else 'baseline'
        player=name[len('real_'):].split(f'_{arm}_')[0]
        summ=next((x['summary'] for x in r if x['dir']=='summary'),None)
        sp=os.path.join(streams_dir,name+'.jsonl')
        matches.append(dict(name=name,arm=arm,player=player,rows=r,summary=summ,stream=rows(sp) if os.path.exists(sp) else []))
    players=sorted({m['player'] for m in matches})
    print('MATCHES',len(matches),'commit',{m['summary']['game_commit'] for m in matches if m['summary']})
    # 1 shares
    print('\n[1] shares per arm')
    for pl in players:
        for arm in ('adapt','baseline'):
            ms=[m for m in matches if m['player']==pl and m['arm']==arm and m['summary']]
            pts=sum(m['summary']['rounds_played'] for m in ms); won=sum(m['summary']['score']['player'] for m in ms)
            halves=[0,0,0,0]
            for m in ms:
                re=[x['message'] for x in m['rows'] if x['dir']=='out' and x['message']['type']=='round_end']
                h=len(re)//2
                halves[0]+=sum(1 for x in re[:h] if x['winner']=='player'); halves[1]+=h
                halves[2]+=sum(1 for x in re[h:] if x['winner']=='player'); halves[3]+=len(re)-h
            vu=[len(m['summary']['versions_used']) for m in ms]
            print(f"  {pl:38s} {arm:8s} n={len(ms)} points={pts} player {pct(won/pts) if pts else '-'} opponent {pct(1-won/pts) if pts else '-'} | player first half {pct(halves[0]/halves[1]) if halves[1] else '-'} last half {pct(halves[2]/halves[3]) if halves[3] else '-'} | behaviours used mean {round(sum(vu)/len(vu),1) if vu else '-'} | per match {[str(m['summary']['score']['player'])+'-'+str(m['summary']['score']['opponent']) for m in ms]}")
    ad=[m for m in matches if m['arm']=='adapt' and m['summary']]
    # 2 errors
    print('\n[2] errors in clean matches:', sum(len(m['summary']['errors']) for m in matches if m['summary']), 'of', len(matches), 'matches; would-not-apply notes:', sum(len(m['summary']['game_would_not_apply']) for m in matches if m['summary']), '; setup_to_ready s:', sorted(m['summary']['setup_to_ready_seconds'] for m in ad)[:3], '..', max(m['summary']['setup_to_ready_seconds'] for m in ad) if ad else None)
    # 3 watcher
    wms=[];werr=collections.Counter();wstart=0
    for m in ad:
        for x in m['stream']:
            t=x['message']
            if t.get('type')=='trace' and t.get('stage')=='watcher':
                if t['status']=='done' and 'ms' in t: wms.append(t['ms'])
                if t['status']=='start': wstart+=1
                if t['status']=='error': werr[t.get('about','')[:60]]+=1
    print('\n[3] watcher calls done',len(wms),'median ms',med(wms),'p90',p90(wms),'max',max(wms) if wms else None,'| starts',wstart,'errors',dict(werr))
    truthmap={'forehand':lambda d:d.get('side')=='forehand','left':lambda d:str(d.get('lands','')).startswith('left_'),'dropshot':lambda d:d.get('shot_type')=='dropshot'}
    def valname(vals,kind):
        for k in vals:
            if kind=='forehand' and k in('favors_forehand',): return k
            if kind=='left' and k.startswith('aims_left'): return k
            if kind=='dropshot' and 'dropshot' in k and not k.startswith('like_'): return k
        return None
    errs={'first':[], 'mid':[], 'last':[]}; likeok=collections.Counter(); bykind=collections.defaultdict(list)
    for m in ad:
        shots=[x['message']['data'] for x in m['rows'] if x['dir']=='out' and x['message']['type']=='event' and x['message']['name']=='shot' and x['message']['by']=='player']
        reads=[x['message'] for x in m['rows'] if x['dir']=='in' and x['message']['type']=='player_read']
        if len(shots)<5 or len(reads)<3: continue
        for kind,f in truthmap.items():
            truth=sum(1 for d in shots if f(d))/len(shots)
            vn=valname(reads[-1]['values'],kind)
            if not vn: continue
            for label,rd in (('first',reads[0]),('mid',reads[len(reads)//2]),('last',reads[-1])):
                errs[label].append(abs(rd['values'].get(vn,0)-truth))
            bykind[(m['player'],kind)].append((round(truth,2),round(reads[-1]['values'].get(vn,0),2)))
        if '-to-' not in m['player']:
            likes={k:v for k,v in reads[-1]['values'].items() if k in('like_forehand_lover','like_baseline_grinder','like_even')}
            if likes: likeok[(m['player'], max(likes,key=likes.get)=='like_'+m['player'])]+=1
    print('  mean abs error of read vs the match\'s true share (forehand, aims left, dropshots): first read',round(st.mean(errs['first']),3) if errs['first'] else None,'middle',round(st.mean(errs['mid']),3) if errs['mid'] else None,'last',round(st.mean(errs['last']),3) if errs['last'] else None,'n',len(errs['last']))
    for k,v in sorted(bykind.items()): print('   ',k,'(truth,last read) per match',v)
    print('  like_<player> highest at the end:',dict(likeok))
    # 4 local picks
    tot=sum(m['summary']['picks']['total'] for m in ad); br=sum(m['summary']['picks']['by_rule'] for m in ad)
    print('\n[4] picks',tot,'by rule',br,pct(br/tot) if tot else '-','| max lag ms per match',sorted(m['summary']['max_lag_behind_wall_clock_ms'] for m in ad)[-3:],'| mid-round behaviour changes',[ (m['name'][-30:],m['summary']['mid_round_behaviour_changes']) for m in ad if m['summary']['mid_round_behaviour_changes']][:6])
    never=sum(len(m['summary']['updates_never_played']) for m in ad); ups=sum(len(m['summary']['updates']) for m in ad)
    print('  updates received',ups,'never played (replaced before a gap or after the last point)',never)
    # 5 larger loop
    ams=[];ready=[];timeouts=0;aerr=collections.Counter();usage=collections.Counter();writers=collections.Counter();holds=collections.Counter()
    for m in ad:
        for x in m['stream']:
            t=x['message']
            if t.get('type')!='trace' or t.get('stage')!='adapter': continue
            d=t.get('data') or {}
            if t['status']=='done' and t.get('model') and 'usage' in d:
                ams.append(t['ms']); 
                for k,v in d['usage'].items(): usage[k]+=v
            if t['status']=='done' and 'repaired' in d: ready.append(d); writers[d.get('writer')]+=1
            if t['status']=='error': aerr[t.get('about','')[:90]]+=1
            if t['status']=='done' and not t.get('model') and d.get('writer')=='fairness' and 'setting' not in d: holds[t.get('about','')[:70]]+=1
    print('\n[5] adapter model calls',len(ams),'median s',med([a/1000 for a in ams]),'p90',p90([a/1000 for a in ams]),'max',round(max(ams)/1000,1) if ams else None)
    print('  versions made by a writer',len(ready),'clean first time',sum(1 for d in ready if not d['repaired'] and not d['problems'] and not d['dropped']),'repaired',sum(1 for d in ready if d['repaired']),'with dropped parts',sum(1 for d in ready if d['dropped']),'writers',dict(writers))
    print('  adapter errors',dict(aerr)); print('  fairness holds',dict(holds))
    nochange=0;nowhy=0;same=0;total=0;gaps=[]
    speeds=[]
    for m in ad:
        prev=None;prevset=None;pw=None
        for x in m['rows']:
            if x['dir']!='in': continue
            t=x['message']
            if t['type']=='ready': prev=json.dumps(t['behaviour'].get('npcs'),sort_keys=True)
            if t['type']=='strategy_update':
                total+=1
                if not t.get('changes'): nochange+=1
                if any(not c.get('why') for c in t.get('changes') or []): nowhy+=1
                cur=json.dumps(t['behaviour'].get('npcs'),sort_keys=True)
                if cur==prev and not t.get('settings'): same+=1
                prev=cur
                if pw is not None: gaps.append(x['wall']-pw)
                pw=x['wall']
                if t.get('settings') and 'opponent_speed' in t['settings']: speeds.append(t['settings']['opponent_speed'])
    print('  updates',total,'with no changes listed',nochange,'with a change missing why',nowhy,'identical behaviour and no settings',same,'| gap between updates s median',med(gaps),'p90',p90(gaps))
    # 6 dial
    print('\n[6] opponent_speed values sent',len(speeds),'min',min(speeds) if speeds else None,'max',max(speeds) if speeds else None)
    # 8 tokens
    wtok=sum((x['message'].get('data') or {}).get('input_tokens') or 0 for m in ad for x in m['stream'] if x['message'].get('type')=='trace' and x['message'].get('stage')=='watcher' and x['message'].get('status')=='done')
    print('\n[8] tokens over',len(ad),'adapting matches: adapter',dict(usage),'| watcher input tokens',wtok,'| per match adapter in/out/thinking',{k:round(v/len(ad)) for k,v in usage.items()} if ad else None,'watcher in per match',round(wtok/len(ad)) if ad else None)
    # known: convergence
    print('\n[known] opponent shot mix in the last 10 points, and final rules')
    for pl in players:
        for arm in ('adapt','baseline'):
            c=collections.Counter()
            for m in matches:
                if m['player']!=pl or m['arm']!=arm or not m['summary']: continue
                last=m['summary']['rounds_played']-10
                for x in m['rows']:
                    t=x.get('message')
                    if x['dir']=='out' and t['type']=='event' and t['name']=='shot' and t['by']=='opponent' and t['round']>last: c[t['picked']['shot_type']]+=1
            n=sum(c.values())
            print(f"  {pl:38s} {arm:8s} shots {n} " + ' '.join(f"{k} {pct(v/n)}" for k,v in c.most_common()))
    for m in ad:
        lastup=[x['message'] for x in m['rows'] if x['dir']=='in' and x['message']['type'] in('strategy_update','ready')][-1]
        rules=lastup['behaviour']['npcs']['opponent'].get('rules') or []
        st_=lastup['behaviour']['npcs']['opponent']['decisions'].get('shot_type',{})
        print('  ',m['name'][5:45].ljust(40),'final v',lastup['behaviour'].get('version'),'rules',[json.dumps(r['do']) for r in rules],'dropshot base',st_.get('dropshot',{}).get('base'),'when',st_.get('dropshot',{}).get('when'))


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print(__doc__)
        return 1
    analyse(args[0], args[1])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
