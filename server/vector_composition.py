"""Explicit contour-group fills and duplicate shadows, never inferred styles."""
import math
import re

HEX = re.compile(r'^#[0-9a-fA-F]{6}$')

def _object(value, keys, label):
    if not isinstance(value, dict) or set(value)-set(keys):
        raise ValueError(f'{label} has unsupported fields')

def _color(value):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError('Composition colors must use #rrggbb')
    return value.lower()

def _number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'Composition numbers must be finite and from {low} to {high}')
    return float(value)

def _selector(value, extra, label):
    _object(value, ['color', 'contours', *extra], label)
    ids=value.get('contours')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 128 or any(isinstance(i,bool) or not isinstance(i,int) or not 0 <= i < 20000 for i in ids) or len(set(ids)) != len(ids):
        raise ValueError(f'{label} needs 1 to 128 unique contour indexes')
    return {'color':_color(value.get('color')), 'contours':sorted(ids)}

def _list(value, label, parse):
    if value is None:
        return []
    if not isinstance(value,list) or len(value)>32:
        raise ValueError(f'{label} supports at most 32 selections')
    return [parse(item) for item in value]

def _disjoint(values, label):
    selected=set()
    for v in values:
        for i in v['contours']:
            key=(v['color'],i)
            if key in selected:
                raise ValueError(f'{label} selects a contour more than once')
            selected.add(key)

def _gradient(value):
    _object(value,['angle','stops','bounds'],'Selected gradient')
    stops=value.get('stops')
    if not isinstance(stops,list) or not 2 <= len(stops) <= 8:
        raise ValueError('Selected gradient needs 2 to 8 stops')
    parsed=[]
    for stop in stops:
        _object(stop,['offset','color'],'Gradient stop')
        parsed.append({'offset':_number(stop.get('offset'),0,1),'color':_color(stop.get('color'))})
    if any(b['offset'] < a['offset'] for a,b in zip(parsed,parsed[1:])):
        raise ValueError('Gradient stops must be ordered by offset')
    result={'angle':_number(value.get('angle',0),0,360),'stops':parsed}
    if 'bounds' in value:
        b=value['bounds']
        if not isinstance(b,list) or len(b)!=4:
            raise ValueError('Selected gradient bounds must be [x,y,width,height]')
        result['bounds']=[_number(n,-16384 if i<2 else .001,32768) for i,n in enumerate(b)]
    return result

def normalize_composition(value):
    if value is None:
        return None
    _object(value,['fills','shadows','omit'],'Composition')
    def fill(v):
        result=_selector(v,['solid','gradient'],'Selected fill')
        if ('solid' in v)==('gradient' in v):
            raise ValueError('Selected fill needs either solid or gradient')
        result.update({'solid':_color(v['solid'])} if 'solid' in v else {'gradient':_gradient(v['gradient'])})
        return result
    def shadow(v):
        result=_selector(v,['fill','offset'],'Shadow')
        offset=v.get('offset')
        if not isinstance(offset,list) or len(offset)!=2:
            raise ValueError('Shadow offset must be [dx,dy]')
        result.update(fill=_color(v.get('fill')),offset=[_number(n,-4096,4096) for n in offset])
        return result
    result={'fills':_list(value.get('fills'),'Selected fills',fill),
            'shadows':_list(value.get('shadows'),'Shadows',shadow),
            'omit':_list(value.get('omit'),'Omitted contours',lambda v:_selector(v,[],'Omit'))}
    _disjoint(result['fills'],'Selected fills')
    _disjoint(result['omit'],'Omitted contours')
    return result

def select(selection, inventory, *, complete=False, excluded=()):
    color=selection['color']
    if color not in inventory:
        raise ValueError(f'Selected palette color was not retained: {color}')
    parts, contours=inventory[color]
    ids=selection['contours']
    if any(i>=len(parts) for i in ids):
        raise ValueError(f'Selected contour index was not found for {color}')
    chosen=set(ids)
    excluded=set(excluded)
    if complete:
        for i, c in enumerate(contours):
            if i in excluded:
                continue
            mismatched=((i in chosen)!=(c.get('parent') in chosen)) if complete is True else ((c.get('parent') in chosen) and i not in chosen)
            if c['hole'] and mismatched:
                raise ValueError('Fill and shadow selections must include foreground outlines together with their holes')
    return ''.join(parts[i] for i in ids), [contours[i] for i in ids]


def compound_parts(parts, contours, ids=None):
    """Union independent foreground objects, retaining each object's own holes.

    One even-odd path for every palette would XOR overlapping positive shapes.
    A separate compound path per foreground preserves their union instead.
    """
    selected=set(range(len(parts)) if ids is None else ids)
    holes={}
    for i in sorted(selected):
        if contours[i]['hole']:
            parent=contours[i].get('parent')
            if parent not in selected:
                raise ValueError('A hole needs its foreground outline')
            holes.setdefault(parent,[]).append(i)
    return [(i,parts[i]+''.join(parts[h] for h in holes.get(i,[])))
            for i in sorted(selected) if not contours[i]['hole']]

def bounds_for(contours):
    boxes=[c['bounds'] for c in contours]
    x=min(b[0] for b in boxes); y=min(b[1] for b in boxes)
    return [x,y,max(b[0]+b[2] for b in boxes)-x,max(b[1]+b[3] for b in boxes)-y]
