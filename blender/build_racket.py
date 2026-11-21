"""
Blender 5.1 headless generator for a stylized Pro Tennis Racket.
Exports: client/public/models/racket.glb

Origin is at the grip center (player hand holds it at local (0,0,0), racket extends along +Z in Blender -> +Y in glTF).
Includes an empty named 'SweetSpot' at the center of the string bed for contact probing (matching Tennis-Game-Spec).
"""

import os
import math
import bpy
import bmesh

OUT_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "client", "public", "models", "racket.glb")
)
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_mat(name, color, roughness=0.45, metallic=0.1, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None and emission_strength > 0 and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def add_cylinder(name, r1, r2, depth, loc, rot, mat, segments=14, parent=None):
    mesh = bpy.data.meshes.new(name + "_Mesh")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r1, radius2=r2, depth=depth)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    bpy.context.collection.objects.link(obj)
    if parent:
        obj.parent = parent
    return obj


def build_racket():
    clear_scene()
    root = bpy.data.objects.new("TennisRacket", None)
    bpy.context.collection.objects.link(root)

    mat_grip = make_mat("GripBlack", (0.06, 0.06, 0.07), roughness=0.88)
    mat_frame = make_mat("CarbonFrame", (0.10, 0.12, 0.16), roughness=0.28, metallic=0.45)
    mat_accent = make_mat("FrameAccent", (0.14, 0.78, 0.96), roughness=0.30, metallic=0.2, emission=(0.14, 0.78, 0.96), emission_strength=0.2)
    mat_string = make_mat("Strings", (0.94, 0.95, 0.90), roughness=0.45)

    # Real tennis racket ~ 0.685 m long.
    # Handle: z = -0.05 .. +0.16 (grip center at z = 0)
    add_cylinder("HandleGrip", 0.017, 0.016, 0.21, (0, 0, 0.055), (0, 0, 0), mat_grip, segments=8, parent=root)
    add_cylinder("ButtCap", 0.021, 0.018, 0.018, (0, 0, -0.055), (0, 0, 0), mat_accent, segments=8, parent=root)

    # Throat Y-bridge (z = 0.16 .. 0.34)
    add_cylinder("ThroatLeft", 0.010, 0.011, 0.21, (-0.048, 0, 0.255), (0, 0.42, 0), mat_frame, segments=10, parent=root)
    add_cylinder("ThroatRight", 0.010, 0.011, 0.21, (0.048, 0, 0.255), (0, -0.42, 0), mat_frame, segments=10, parent=root)
    add_cylinder("ThroatBridge", 0.009, 0.009, 0.11, (0, 0, 0.325), (0, math.pi / 2, 0), mat_accent, segments=10, parent=root)

    # Oval head hoop centered at z = 0.505, rx = 0.135, rz = 0.175
    head_cz = 0.505
    rx = 0.135
    rz = 0.175
    hoop_segs = 32
    for i in range(hoop_segs):
        a0 = (i / hoop_segs) * math.tau
        a1 = ((i + 1) / hoop_segs) * math.tau
        am = (a0 + a1) * 0.5
        p0 = (rx * math.cos(a0), 0.0, head_cz + rz * math.sin(a0))
        p1 = (rx * math.cos(a1), 0.0, head_cz + rz * math.sin(a1))
        pm = ((p0[0] + p1[0]) * 0.5, 0.0, (p0[2] + p1[2]) * 0.5)
        dx = p1[0] - p0[0]
        dz = p1[2] - p0[2]
        seg_len = math.hypot(dx, dz) + 0.005
        # Cylinder axis is Z; rotate around Y to align with (dx, dz)
        angle_y = math.atan2(dx, dz)
        m = mat_accent if (i % 8 in (0, 1)) else mat_frame
        add_cylinder(f"HoopSeg_{i}", 0.0105, 0.0105, seg_len, pm, (0, angle_y, 0), m, segments=8, parent=root)

    # Strings (main vertical + cross horizontal)
    for ix in range(-5, 6):
        sx = ix * 0.021
        ratio = sx / (rx - 0.008)
        if abs(ratio) >= 0.96:
            continue
        half_z = (rz - 0.008) * math.sqrt(max(0.0, 1.0 - ratio * ratio))
        add_cylinder(f"StringMain_{ix}", 0.0014, 0.0014, half_z * 2.0, (sx, 0, head_cz), (0, 0, 0), mat_string, segments=6, parent=root)

    for iz in range(-6, 7):
        sz = iz * 0.023
        ratio = sz / (rz - 0.008)
        if abs(ratio) >= 0.96:
            continue
        half_x = (rx - 0.008) * math.sqrt(max(0.0, 1.0 - ratio * ratio))
        add_cylinder(f"StringCross_{iz}", 0.0014, 0.0014, half_x * 2.0, (0, 0, head_cz + sz), (0, math.pi / 2, 0), mat_string, segments=6, parent=root)

    # SweetSpot empty at center of string bed
    sweet = bpy.data.objects.new("SweetSpot", None)
    sweet.location = (0, 0, head_cz)
    sweet.parent = root
    bpy.context.collection.objects.link(sweet)

    bpy.ops.export_scene.gltf(
        filepath=OUT_PATH,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
    )
    print(f"[OK] Exported racket -> {OUT_PATH}")


if __name__ == "__main__":
    build_racket()
