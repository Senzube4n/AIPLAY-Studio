"""A loud future transient must affect the preceding region exactly as in a full render."""
import copy, tempfile, pathlib
import numpy as np
import soundfile as sf
import engine, rack
sr=48000
lim=lambda ms: {'type':'limiter','enabled':True,'params':{'ceiling_db':-9,'lookahead_ms':ms,'release_ms':80}}
with tempfile.TemporaryDirectory() as folder:
    p=pathlib.Path(folder)/'source.wav'
    t=np.arange(sr*2)/sr
    y=.12*np.sin(2*np.pi*220*t)
    y[sr:sr+480]+=.9*np.sin(2*np.pi*61*np.arange(480)/sr)
    sf.write(p,np.column_stack([y,y*.93]),sr,subtype='FLOAT')
    mx={'stereo':True,'tracks':{'a':{'inserts':[],'fader':0,'pan':0,'sends':[]}},'returns':[],'master':{'inserts':[lim(5)],'fader':0}}
    job={'sr':sr,'start_sample':0,'n_samples':sr*2,'notes':[], 'audio':[{'path':str(p),'track_id':'a','start_sample':0,'offset_samples':0,'dur_samples':sr*2,'gain_db':0}], 'mixer':mx}
    for stacked in (False,True):
        m=copy.deepcopy(mx)
        if stacked:m['tracks']['a']['inserts']=[lim(10),lim(10)]
        whole,buses=rack.chain_graph(dict(job,mixer=m),engine.SYNTHS,True)
        part,pb=rack.chain_graph(dict(job,mixer=m,n_samples=sr),engine.SYNTHS,True)
        assert part.shape==(2,sr) and pb['mix'].shape==(2,sr)
        assert np.array_equal(part.astype('float32'),whole[:,:sr].astype('float32')), np.max(np.abs(part-whole[:,:sr]))
        assert np.array_equal(pb['tracks']['a'].astype('float32'),buses['tracks']['a'][:,:sr].astype('float32'))
    assert rack.graph_future_seconds({'master':{'inserts':[]}})==0
print('7 region lookahead assertions passed, including end-of-region PCM equality')
