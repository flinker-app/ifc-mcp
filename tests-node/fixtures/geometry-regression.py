import ifcopenshell, ifcopenshell.geom, ifcopenshell.guid, json, logging
from pathlib import Path
from ifcclash import Clasher, ClashSettings
from ifcclash.ifcclash import Clasher as UpstreamClasher

assert Clasher is UpstreamClasher and Clasher.__module__ == "ifcclash.ifcclash"
def pt3(model, x, y, z):
    return model.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y), float(z)))


def pt2(model, x, y):
    return model.create_entity("IfcCartesianPoint", Coordinates=(float(x), float(y)))


def direction(model, x, y, z):
    return model.create_entity("IfcDirection", DirectionRatios=(float(x), float(y), float(z)))


def axis3d(model, x=0, y=0, z=0):
    return model.create_entity(
        "IfcAxis2Placement3D",
        Location=pt3(model, x, y, z),
        Axis=direction(model, 0, 0, 1),
        RefDirection=direction(model, 1, 0, 0),
    )


def axis2d(model):
    return model.create_entity(
        "IfcAxis2Placement2D",
        Location=pt2(model, 0, 0),
        RefDirection=model.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0)),
    )


def make_box_file(path, name, loc, dims):
    model = ifcopenshell.file(schema="IFC4")
    unit = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix=None, Name="METRE")
    units = model.create_entity("IfcUnitAssignment", Units=[unit])
    context = model.create_entity(
        "IfcGeometricRepresentationContext",
        ContextIdentifier="Model",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=axis3d(model),
    )
    body = model.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body",
        ContextType="Model",
        ParentContext=context,
        TargetScale=None,
        TargetView="MODEL_VIEW",
        UserDefinedTargetView=None,
    )
    model.create_entity(
        "IfcProject",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=None,
        Name="ClashTest",
        Description=None,
        ObjectType=None,
        LongName=None,
        Phase=None,
        RepresentationContexts=[context],
        UnitsInContext=units,
    )
    placement = model.create_entity("IfcLocalPlacement", PlacementRelTo=None, RelativePlacement=axis3d(model, *loc))
    profile = model.create_entity(
        "IfcRectangleProfileDef",
        ProfileType="AREA",
        ProfileName=None,
        Position=axis2d(model),
        XDim=float(dims[0]),
        YDim=float(dims[1]),
    )
    solid = model.create_entity(
        "IfcExtrudedAreaSolid",
        SweptArea=profile,
        Position=axis3d(model),
        ExtrudedDirection=direction(model, 0, 0, 1),
        Depth=float(dims[2]),
    )
    rep = model.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=body,
        RepresentationIdentifier="Body",
        RepresentationType="SweptSolid",
        Items=[solid],
    )
    pds = model.create_entity("IfcProductDefinitionShape", Name=None, Description=None, Representations=[rep])
    model.create_entity(
        "IfcWall",
        GlobalId=ifcopenshell.guid.new(),
        OwnerHistory=None,
        Name=name,
        Description=None,
        ObjectType=None,
        ObjectPlacement=placement,
        Representation=pds,
        Tag=None,
        PredefinedType=None,
    )
    model.write(path)


def run_clash(name, clash_sets):
    settings = ClashSettings()
    settings.output = f"/home/pyodide/{name}.json"
    logger = logging.getLogger(name)
    logger.handlers.clear()
    logger.addHandler(logging.StreamHandler())
    logger.setLevel(logging.INFO)
    settings.logger = logger
    clasher = Clasher(settings)
    clasher.clash_sets = clash_sets
    clasher.clash()
    clasher.export()
    output = json.loads(Path(settings.output).read_text(encoding="utf-8"))
    counts = [len(item.get("clashes", {})) for item in output]
    print(f"{name}: counts={counts}")
    return output


make_box_file("/home/pyodide/box_a.ifc", "Box A", (0, 0, 0), (2, 2, 2))
make_box_file("/home/pyodide/box_b.ifc", "Box B", (1, 0.3, 0.2), (2, 2, 2))
make_box_file("/home/pyodide/box_c.ifc", "Box C", (5, 0, 0), (2, 2, 2))

overlap = run_clash("generated_overlap", [{
    "name": "generated-overlap",
    "mode": "intersection",
    "tolerance": 0.0,
    "check_all": True,
    "a": [{"file": "/home/pyodide/box_a.ifc"}],
    "b": [{"file": "/home/pyodide/box_b.ifc"}],
}])
assert len(overlap[0]["clashes"]) == 1, overlap

# Desktop IfcOpenShell reports no intersection for this coplanar arrangement.
make_box_file("coplanar.ifc", "Aligned box", (1, 0, 0), (2, 2, 2))
coplanar = run_clash("coplanar", [{
    "name": "coplanar", "mode": "intersection", "tolerance": 0.0, "check_all": True,
    "a": [{"file": "box_a.ifc"}], "b": [{"file": "coplanar.ifc"}],
}])
assert not coplanar[0]["clashes"], coplanar

separate = run_clash("generated_separate", [{
    "name": "generated-separate",
    "mode": "intersection",
    "tolerance": 0.0,
    "check_all": True,
    "a": [{"file": "/home/pyodide/box_a.ifc"}],
    "b": [{"file": "/home/pyodide/box_c.ifc"}],
}])
assert len(separate[0]["clashes"]) == 0, separate

clearance = run_clash("generated_clearance", [{
    "name": "generated-clearance",
    "mode": "clearance",
    "clearance": 4.0,
    "check_all": False,
    "a": [{"file": "/home/pyodide/box_a.ifc"}],
    "b": [{"file": "/home/pyodide/box_c.ifc"}],
}])
assert len(clearance[0]["clashes"]) == 1, clearance

collision = run_clash("generated_collision", [{
    "name": "generated-collision", "mode": "collision", "allow_touching": True,
    "a": [{"file": "box_a.ifc"}], "b": [{"file": "box_b.ifc"}],
}])
assert len(collision[0]["clashes"]) == 1, collision

# The smaller box is off-centre, 30 mm above the face of the larger box.
make_box_file("small.ifc", "Small", (0.5, 0.5, 2.03), (0.1, 0.1, 0.1))
gaps = run_clash("surface_clearance", [{
    "name": str(limit), "mode": "clearance", "check_all": True, "clearance": limit,
    "a": [{"file": "box_a.ifc"}], "b": [{"file": "small.ifc"}],
} for limit in (0.02, 0.05)])
assert not gaps[0]["clashes"] and len(gaps[1]["clashes"]) == 1, gaps
distance = next(iter(gaps[1]["clashes"].values()))["distance"]
assert abs(distance - 0.03) < 1e-6, distance

result = {"clasher": Clasher.__module__, "overlap": len(overlap[0]["clashes"]),
          "separate": len(separate[0]["clashes"]), "collision": len(collision[0]["clashes"]),
          "clearance_metres": distance}
