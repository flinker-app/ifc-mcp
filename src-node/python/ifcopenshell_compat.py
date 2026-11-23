"""Compatibility fixes for companion packages and IFCZIP output."""


def install():
    import ifcopenshell
    import ifcopenshell.util.placement as placement
    from pathlib import Path
    import tempfile
    import zipfile

    # bcf-client 0.9.0 still calls the old function. get_placement composes
    # parent placements and returns translation in file units by default.
    if not hasattr(placement, "get_local_placement") and hasattr(placement, "get_placement"):
        placement.get_local_placement = placement.get_placement

    # Upstream ZIP writing uses a sibling .ifc file as scratch space and deletes
    # it afterwards. Keep an existing STEP output intact when writing its ZIP.
    original_write = ifcopenshell.file.write

    def write(self, path, format=None, zipped=False):
        path = Path(path)
        output_format = format or ifcopenshell.guess_format(path)
        if output_format != ".ifcZIP" and not zipped:
            return original_write(self, path, format, zipped)
        inner_format = ".ifc" if output_format == ".ifcZIP" else output_format or ".ifc"
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as directory:
            unzipped = Path(directory) / path.with_suffix(inner_format).name
            original_write(self, unzipped, inner_format, False)
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(unzipped, unzipped.name)

    ifcopenshell.file.write = write
