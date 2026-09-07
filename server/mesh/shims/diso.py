"""A stand-in for the `diso` CUDA extension — import-only, and it BITES.

WHY THIS IS IN THE REPOSITORY AND NOT IN SOMEBODY'S VENV
--------------------------------------------------------
`diso` publishes an sdist and no wheels, and building it needs an MSVC C++
toolchain. A machine can have CUDA and still not have that — this one has nvcc
12.1 and no `cl.exe` at all.

TripoSG imports `DiffDMC` at MODULE scope in triposg/inference_utils.py, so the
import has to succeed for the pipeline to load at all. But DiffDMC is only
INSTANTIATED inside flash_extract_geometry(), which runs only when the pipeline
is called with `use_flash_decoder=True`. mesh_cli.py passes False and takes the
hierarchical marching-cubes path, which never touches diso.

⚠ SO THIS SHIM MAKES THE IMPORT WORK AND MAKES THE FLASH PATH IMPOSSIBLE. The
constructor raises. A silent fall-through to the wrong decoder would be a
different mesh reported as the same one, which is the failure worth preventing;
a loud NotImplementedError is not.

⚠ AND IT IS APPENDED TO sys.path, NEVER PREPENDED (see _add_triposg in
mesh_cli.py), so a machine that has the real extension uses the real extension.
This is a floor under a machine that cannot build it, not a replacement for one
that can.
"""

__version__ = "0.0.0+shim-nodiso"
__is_shim__ = True


class DiffDMC:
    def __init__(self, *a, **k):
        raise NotImplementedError(
            "diso is not installed — this is the shim at " + __file__ + ". "
            "TripoSG's flash decoder (use_flash_decoder=True) needs the real diso CUDA "
            "extension, which is source-only and needs an MSVC toolchain this machine does "
            "not have. server/mesh/mesh_cli.py calls the pipeline with use_flash_decoder=False "
            "and takes the hierarchical marching-cubes decoder instead; if you are seeing this, "
            "something asked for the flash path anyway."
        )
