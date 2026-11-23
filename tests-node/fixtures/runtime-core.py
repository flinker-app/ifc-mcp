"""Round trips and geometry checks for the supported IfcOpenShell environment."""
import importlib.metadata
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import pandas as pd
from pathlib import Path

schemas = [ifcopenshell.file(schema=name).schema for name in ("IFC2X3", "IFC4", "IFC4X3_ADD2")]
model = ifcopenshell.open("model.ifc")
walls = model.by_type("IfcWall")
assert len(walls) == 1
assert len(model.by_type("IfcWindow")) == 2
assert ifcopenshell.util.element.get_psets(walls[0])["Pset_WallCommon"]["FireRating"] == "EI60"

model.by_type("IfcProject")[0].Name = "Upgraded runtime"
model.write("edited.ifc")
step_bytes = Path("edited.ifc").read_bytes()
reopened = ifcopenshell.open("edited.ifc")
assert reopened.by_type("IfcProject")[0].Name == "Upgraded runtime"
model.write("edited.ifczip")
assert Path("edited.ifc").read_bytes() == step_bytes, "Writing IFCZIP must preserve an existing STEP output"
unzipped = ifcopenshell.open("edited.ifczip")
assert unzipped.by_type("IfcProject")[0].Name == "Upgraded runtime"
model.write("explicit.zip", format=".ifc", zipped=True)
explicit_zip = ifcopenshell.open("explicit.zip", format=".ifcZIP")
assert explicit_zip.by_type("IfcProject")[0].Name == "Upgraded runtime"

lazy = ifcopenshell.open("edited.ifc", lazy=True)
assert lazy.by_type("IfcWall")[0].GlobalId == walls[0].GlobalId
assert ifcopenshell.util.element.get_psets(lazy.by_type("IfcWall")[0])["Pset_WallCommon"]["FireRating"] == "EI60"

shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), walls[0])
assert len(shape.geometry.verts) > 0 and len(shape.geometry.faces) > 0
pd.DataFrame([{"name": walls[0].Name, "fire_rating": "EI60"}]).to_csv("report.csv", index=False)

result = {
    "version": ifcopenshell.version,
    "package_version": importlib.metadata.version("ifcopenshell"),
    "schemas": schemas,
    "wall_count": len(walls),
    "window_count": len(model.by_type("IfcWindow")),
    "geometry_vertices": len(shape.geometry.verts) // 3,
    "geometry_triangles": len(shape.geometry.faces) // 3,
    "ifc_round_trip": True,
    "ifczip_round_trip": True,
    "lazy_property_query": True,
}
