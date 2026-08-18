# Your own ComfyUI graphs

Drop **API-format** graphs in this folder and pick them in Settings → Custom
workflows. Studio submits your graph as-is, filling in a few placeholders.

## Getting the right file

In ComfyUI: Settings → enable **Dev Mode**, then **Save (API Format)**.

The ordinary "Save" writes the *editor document* (nodes, positions, links). It is
also JSON, it also loads without complaint, and ComfyUI's `/prompt` cannot run
it. Studio detects that file and tells you — but it is by far the most common
way this goes wrong, so it is worth getting right the first time.

## Placeholders

Put these in your graph where you want Studio to fill in a value.

| token | what goes there |
|---|---|
| `%prompt%` | the description Studio generated or you typed |
| `%negative%` | negative prompt, if your graph has one |
| `%seed%` | a number — put it in your sampler's seed input |
| `%width%` / `%height%` | output size in pixels |
| `%length%` | frame count, for video graphs |
| `%filename%` | output prefix — this is how Studio finds your result |

Numeric tokens are substituted **without quotes**, so write them quoted in the
file (`"seed": "%seed%"`) and they come out as real numbers. Text is
JSON-escaped, so quotes and newlines in a prompt are safe.

None of them are required. A graph with no `%prompt%` renders the same thing
every time, which is a legitimate thing to want — Studio says so rather than
refusing.

`_example.json` is a plain SD-style text-to-image graph showing all of them.
It will not run as-is: point `ckpt_name` at a checkpoint you actually have.
