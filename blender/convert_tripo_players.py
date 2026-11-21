# Usage:
#   blender -b -P blender/convert_tripo_players.py -- --gemini <path.fbx> --gpt <path.fbx>
# Outputs client/public/models/{player_athlete,ai_athlete}.glb and blender/previews/player_{gemini,gpt}.png.
r"""
Headless Blender 5.1 script to convert the two rigged Tripo FBX characters
into lightweight, game-ready glTF/GLB models for "Gemini vs GPT":

  - Gemini player (human, near side) -> client/public/models/player_athlete.glb
  - GPT opponent  (AI, far side)     -> client/public/models/ai_athlete.glb

Also re-imports each exported GLB into a clean scene and renders a front preview:
  - blender/previews/player_gemini.png
  - blender/previews/player_gpt.png

Run with headless Blender 5.1:
  "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --factory-startup -P blender/convert_tripo_players.py -- --gemini <path.fbx> --gpt <path.fbx>
"""

import argparse
import math
import os
import sys
import bpy
from mathutils import Vector

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODELS_DIR = os.path.join(REPO_ROOT, "client", "public", "models")
PREVIEWS_DIR = os.path.join(REPO_ROOT, "blender", "previews")

os.makedirs(MODELS_DIR, exist_ok=True)
os.makedirs(PREVIEWS_DIR, exist_ok=True)

TARGET_HEIGHT_M = 1.80
TARGET_FACES = 20000
MAX_TEX_SIZE = 512
JPEG_QUALITY = 80


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(
        description="Convert rigged Tripo FBX characters to lightweight glTF/GLB models."
    )
    parser.add_argument(
        "--gemini",
        required=True,
        help="Path to the Gemini (player) Tripo FBX input file.",
    )
    parser.add_argument(
        "--gpt",
        required=True,
        help="Path to the GPT (opponent) Tripo FBX input file.",
    )
    return parser.parse_args(argv)


def build_players(gemini_fbx, gpt_fbx):
    return [
        {
            "label": "Gemini (Player)",
            "input_fbx": os.path.abspath(os.path.expanduser(gemini_fbx)),
            "output_glb": os.path.join(MODELS_DIR, "player_athlete.glb"),
            "preview_png": os.path.join(PREVIEWS_DIR, "player_gemini.png"),
        },
        {
            "label": "GPT (Opponent)",
            "input_fbx": os.path.abspath(os.path.expanduser(gpt_fbx)),
            "output_glb": os.path.join(MODELS_DIR, "ai_athlete.glb"),
            "preview_png": os.path.join(PREVIEWS_DIR, "player_gpt.png"),
        },
    ]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def get_evaluated_world_bbox(mesh_objs):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mins = [float("inf"), float("inf"), float("inf")]
    maxs = [float("-inf"), float("-inf"), float("-inf")]

    for obj in mesh_objs:
        ev = obj.evaluated_get(depsgraph)
        me = ev.to_mesh()
        try:
            mw = obj.matrix_world
            for v in me.vertices:
                p = mw @ v.co
                for i in range(3):
                    if p[i] < mins[i]:
                        mins[i] = p[i]
                    if p[i] > maxs[i]:
                        maxs[i] = p[i]
        finally:
            ev.to_mesh_clear()

    return Vector(mins), Vector(maxs)


def drop_animations_and_reset_pose(arm_obj):
    if arm_obj.animation_data:
        arm_obj.animation_data_clear()
    for obj in bpy.data.objects:
        if obj.animation_data:
            obj.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action, do_unlink=True)
    for pb in arm_obj.pose.bones:
        pb.matrix_basis.identity()


def decimate_mesh_preserving_weights(mesh_obj, target_faces):
    poly_count = len(mesh_obj.data.polygons)
    if poly_count <= target_faces:
        print(f"  Mesh {mesh_obj.name} already {poly_count} faces <= {target_faces}, skipping decimate")
        return

    ratio = max(0.05, min(1.0, float(target_faces) / float(poly_count)))

    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj

    mod = mesh_obj.modifiers.new(name="GameDecimate", type="DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True

    # Place decimate before the Armature modifier so it evaluates on bind-pose geometry
    bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
    bpy.ops.object.modifier_apply(modifier=mod.name)

    # Keep skin weights clean for glTF (max 4 joint influences per vertex, normalized)
    if len(mesh_obj.vertex_groups) > 0:
        bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
        bpy.ops.object.mode_set(mode="OBJECT")

    print(f"  Decimated {mesh_obj.name}: {poly_count} -> {len(mesh_obj.data.polygons)} faces (ratio={ratio:.3f}, vgroups={len(mesh_obj.vertex_groups)})")


def optimize_materials_and_textures(max_size):
    used_images = set()

    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links

        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue

        # Tripo FBX links a duplicate 4K Base Color texture to BSDF Alpha (all opaque 1.0).
        # Unlink Alpha so the glTF exporter treats the material as OPAQUE and encodes JPEG cleanly.
        alpha_inp = bsdf.inputs.get("Alpha")
        if alpha_inp is not None and alpha_inp.is_linked:
            for lk in list(alpha_inp.links):
                links.remove(lk)
            alpha_inp.default_value = 1.0

        # Ensure sensible PBR roughness if not already texture-driven
        rough_inp = bsdf.inputs.get("Roughness")
        if rough_inp is not None and not rough_inp.is_linked:
            rough_inp.default_value = 0.65

        # Collect only images still connected to the shader graph
        for node in list(nodes):
            if node.type == "TEX_IMAGE":
                has_out_link = any(o.is_linked for o in node.outputs)
                if has_out_link and node.image is not None:
                    used_images.add(node.image)
                elif not has_out_link:
                    nodes.remove(node)

    # Remove unused images
    for im in list(bpy.data.images):
        if im not in used_images:
            bpy.data.images.remove(im, do_unlink=True)

    # Resize remaining images to max_size (preserving aspect ratio) and repack
    for im in list(used_images):
        w, h = im.size[0], im.size[1]
        if w == 0 or h == 0:
            continue
        if max(w, h) > max_size:
            scale = float(max_size) / float(max(w, h))
            nw = max(1, int(round(w * scale)))
            nh = max(1, int(round(h * scale)))
            im.scale(nw, nh)
            print(f"  Resized texture '{im.name}': {w}x{h} -> {nw}x{nh} ({im.colorspace_settings.name})")
        else:
            print(f"  Kept texture '{im.name}': {w}x{h} ({im.colorspace_settings.name})")
        try:
            im.pack()
        except Exception as e:
            print(f"  Warning: could not pack '{im.name}': {e}")


def render_front_preview(glb_path, preview_png, label):
    """Re-import the exported GLB into a clean scene and render a crisp front portrait."""
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=glb_path)

    meshes = [o for o in bpy.data.objects if o.type == "MESH" and "icosphere" not in o.name.lower()]
    # Hide any helper bone-shape meshes created by glTF importer
    for o in bpy.data.objects:
        if o.type == "MESH" and o not in meshes:
            o.hide_render = True
            o.hide_viewport = True

    bpy.context.view_layer.update()
    mn, mx = get_evaluated_world_bbox(meshes)
    size = mx - mn
    center = (mn + mx) * 0.5
    print(f"  [Verify GLB] {label}: bbox min={[round(v, 4) for v in mn]} max={[round(v, 4) for v in mx]} height={size.z:.4f}m")

    # Add a subtle ground plane at Z=0 so feet grounding is visually obvious
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 0.0, 0.0))
    ground = bpy.context.active_object
    gmat = bpy.data.materials.new("PreviewGround")
    gmat.use_nodes = True
    gbsdf = next(n for n in gmat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    gbsdf.inputs["Base Color"].default_value = (0.14, 0.24, 0.36, 1.0)
    gbsdf.inputs["Roughness"].default_value = 0.85
    ground.data.materials.append(gmat)

    # Studio 3-point lighting
    def add_area_light(name, loc, rot_deg, energy, size_l, color=(1.0, 1.0, 1.0)):
        ldata = bpy.data.lights.new(name, type="AREA")
        ldata.energy = energy
        ldata.size = size_l
        ldata.color = color
        lobj = bpy.data.objects.new(name, ldata)
        lobj.location = loc
        lobj.rotation_euler = tuple(math.radians(a) for a in rot_deg)
        bpy.context.collection.objects.link(lobj)

    # Character faces -Y in Blender (+Z in glTF), so camera sits on -Y looking toward +Y
    add_area_light("KeyLight", (2.2, -3.0, 2.8), (55, 0, 35), 260, 2.5, (1.0, 0.97, 0.93))
    add_area_light("FillLight", (-2.6, -2.5, 2.0), (65, 0, -45), 110, 3.0, (0.85, 0.92, 1.0))
    add_area_light("RimLight", (0.0, 2.5, 2.6), (125, 0, 0), 160, 2.0, (0.9, 0.96, 1.0))

    # Neutral dark slate world background
    world = bpy.data.worlds.new("PreviewWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs["Color"].default_value = (0.09, 0.12, 0.18, 1.0)
        bg.inputs["Strength"].default_value = 0.7

    # Front camera aimed at character center
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 50
    cam_obj = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    cam_dist = max(2.8, size.z * 1.95)
    cam_obj.location = (center.x, center.y - cam_dist, center.z + 0.04)
    direction = (center - cam_obj.location).normalized()
    cam_obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam_obj

    scene = bpy.context.scene
    # Use Cycles CPU for reliable headless rendering across all Windows GPU/driver setups
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = preview_png

    bpy.ops.render.render(write_still=True)
    print(f"  [Preview] Saved {preview_png}")


def convert_player(cfg):
    label = cfg["label"]
    fbx_path = cfg["input_fbx"]
    glb_path = cfg["output_glb"]
    preview_png = cfg["preview_png"]

    print("")
    print(f"=== Converting {label} ===")
    print(f"  Input:  {fbx_path}")
    print(f"  Output: {glb_path}")

    clear_scene()
    bpy.ops.import_scene.fbx(filepath=fbx_path)

    arm_objs = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
    if not arm_objs or not mesh_objs:
        raise RuntimeError(f"Expected armature and mesh in {fbx_path}")

    arm = arm_objs[0]

    # 1. Drop leftover Mixamo action and reset pose bones to clean rest pose
    drop_animations_and_reset_pose(arm)

    # 2. Stand upright WITHOUT altering bone orientations:
    # Tripo FBX imports with Armature.rotation_euler = (+90° X) while its internal
    # edit bones and child mesh are already Z-up in Armature-local space.
    # Zeroing Armature rotation stands the rig upright (facing -Y in Blender -> +Z in glTF)
    # without touching edit bones or bone roll/orientation.
    arm.rotation_mode = "XYZ"
    arm.rotation_euler = (0.0, 0.0, 0.0)
    arm.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    # 3. Scale Armature uniformly so character height is 1.80 m, keeping cm-space bone layout intact
    mn, mx = get_evaluated_world_bbox(mesh_objs)
    raw_height = mx.z - mn.z
    if raw_height <= 0.01:
        raise RuntimeError(f"Invalid mesh height {raw_height} for {label}")

    scale_mul = TARGET_HEIGHT_M / raw_height
    arm.scale = (arm.scale.x * scale_mul, arm.scale.y * scale_mul, arm.scale.z * scale_mul)
    bpy.context.view_layer.update()

    # 4. Place feet strictly at Blender Z = 0 (glTF Y = 0), centered on X
    mn2, mx2 = get_evaluated_world_bbox(mesh_objs)
    cx = (mn2.x + mx2.x) * 0.5
    arm.location = (arm.location.x - cx, arm.location.y, arm.location.z - mn2.z)
    bpy.context.view_layer.update()

    mn3, mx3 = get_evaluated_world_bbox(mesh_objs)
    print(
        f"  Scaled {raw_height:.4f}m -> {mx3.z - mn3.z:.4f}m "
        f"(arm.scale={arm.scale.x:.5f}, feet_z={mn3.z:.5f}, bones={len(arm.data.bones)})"
    )

    # 5. Decimate mesh(es) to ~20k faces while preserving skin weights & UVs
    total_polys = sum(len(m.data.polygons) for m in mesh_objs)
    for m in mesh_objs:
        share = max(500, int(round(TARGET_FACES * (len(m.data.polygons) / max(1, total_polys)))))
        decimate_mesh_preserving_weights(m, share)

    # 6. Shrink textures to 512 px and remove redundant alpha/unused images
    optimize_materials_and_textures(MAX_TEX_SIZE)

    # 7. Export Draco-compressed GLB with JPEG textures and no animations
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        export_yup=True,
        export_animations=False,
        export_image_format="JPEG",
        export_image_quality=JPEG_QUALITY,
        export_jpeg_quality=JPEG_QUALITY,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_unused_images=False,
        export_unused_textures=False,
    )

    size_kb = os.path.getsize(glb_path) / 1024.0
    print(f"  [Exported] {glb_path} ({size_kb:.1f} KB)")

    # 8. Re-import exported GLB and render front preview to verify geometry, scale, and textures
    render_front_preview(glb_path, preview_png, label)


if __name__ == "__main__":
    args = parse_args()
    for cfg in build_players(args.gemini, args.gpt):
        convert_player(cfg)
    print("")
    print("[DONE] Converted both Tripo players and rendered previews.")
