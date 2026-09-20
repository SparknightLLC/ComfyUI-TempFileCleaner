import json
import os
import posixpath
import struct
import threading
import time
import zlib

import folder_paths
from aiohttp import web
from server import PromptServer

try:
	from app.assets.services.asset_management import resolve_hash_to_path
except ImportError:
	resolve_hash_to_path = None

EXTENSION_PATH = os.path.dirname(os.path.realpath(__file__))
LEGACY_CONFIG_PATH = os.path.join(EXTENSION_PATH, "config.json")
RUNTIME_CONFIG_DIRECTORY = folder_paths.get_system_user_directory("temp_file_cleaner")
RUNTIME_CONFIG_PATH = os.path.join(RUNTIME_CONFIG_DIRECTORY, "settings.json")
BASE_DIRECTORY = os.path.abspath(folder_paths.base_path)
LOG_PREFIX = "[TempFileCleaner]"
PROTECTED_FILE_LEASE_SECONDS = 300
MAX_PROTECTED_FILES_PER_CLIENT = 10000
MAX_PROTECTED_FILE_REFERENCE_LENGTH = 4096
PROTECTED_NODE_INPUTS = {
	"LoadImage": "image",
	"LoadImageMask": "image",
	"LoadImageOutput": "image"
}
# Preview nodes are not protected from cleaning - the images they show are
# temp files - but a row pointing at one that was cleaned is repaired the same
# way, so the workflow still runs.
REPAIRABLE_NODE_INPUTS = {
	**PROTECTED_NODE_INPUTS,
	"PreviewImage": "image"
}
PLACEHOLDER_FILE_NAME = "temp_file_cleaner_placeholder.png"
PLACEHOLDER_SIZE = 16
PLACEHOLDER_GRAY = 0x80

DEFAULT_CONFIG = {
	"age_limit": 120,
	"check_frequency": 10,
	"max_files": 100,
	"enable_logging": True,
	"protect_active_files": True,
	"repair_missing_files": True,
	"trash_destination": "",
	"cleaning_paths": "temp",
	"whitelist": "",
	"blacklist": "bedroom.mp4,example_image.jpg,groceries.jpg,image.png"
}

config_lock = threading.RLock()
protected_files_lock = threading.RLock()
protected_files_by_client = {}


def log_message(message, enabled = True):
	if enabled:
		print(f"{LOG_PREFIX} {message}")


def normalize_integer(value, fallback, minimum = 0):
	if isinstance(value, bool):
		return fallback

	try:
		return max(minimum, int(value))
	except (TypeError, ValueError):
		return fallback


def normalize_boolean(value, fallback):
	if isinstance(value, bool):
		return value

	if isinstance(value, (int, float)):
		return bool(value)

	if isinstance(value, str):
		normalized_value = value.strip().lower()
		if normalized_value in ("1", "true", "yes", "on"):
			return True
		if normalized_value in ("0", "false", "no", "off", ""):
			return False

	return fallback


def normalize_string(value, fallback):
	if isinstance(value, str):
		return value.strip()

	return fallback


def split_cleaning_paths(cleaning_paths):
	if not isinstance(cleaning_paths, str):
		return []

	normalized_paths = []
	seen_paths = set()

	for raw_path in cleaning_paths.split(","):
		candidate_path = raw_path.strip().replace("\\", "/")
		if not candidate_path:
			continue

		if candidate_path.startswith("/") or ":" in candidate_path.split("/", 1)[0]:
			continue

		normalized_path = posixpath.normpath(candidate_path)
		if normalized_path in ("", "."):
			continue

		if normalized_path == ".." or normalized_path.startswith("../"):
			continue

		if normalized_path not in seen_paths:
			seen_paths.add(normalized_path)
			normalized_paths.append(normalized_path)

	return normalized_paths


def normalize_cleaning_paths(value):
	normalized_paths = split_cleaning_paths(value)
	if normalized_paths:
		return ",".join(normalized_paths)

	return DEFAULT_CONFIG["cleaning_paths"]


def split_file_names(file_names):
	if not isinstance(file_names, str):
		return []

	normalized_file_names = []
	seen_file_names = set()

	for raw_file_name in file_names.split(","):
		candidate_file_name = raw_file_name.strip()
		if not candidate_file_name:
			continue

		if "/" in candidate_file_name or "\\" in candidate_file_name:
			continue

		normalized_file_name = os.path.basename(candidate_file_name)
		if normalized_file_name in ("", ".", ".."):
			continue

		file_name_key = normalized_file_name.casefold()
		if file_name_key not in seen_file_names:
			seen_file_names.add(file_name_key)
			normalized_file_names.append(normalized_file_name)

	return normalized_file_names


def normalize_file_name_list(value, fallback = ""):
	if not isinstance(value, str):
		return fallback

	normalized_file_names = split_file_names(value)
	if normalized_file_names:
		return ",".join(normalized_file_names)

	return ""


def get_config_value(raw_config, key):
	if key in raw_config:
		return raw_config[key]

	return DEFAULT_CONFIG[key]


def normalize_config(raw_config):
	normalized_config = dict(DEFAULT_CONFIG)
	if not isinstance(raw_config, dict):
		return normalized_config

	normalized_config["age_limit"] = normalize_integer(raw_config.get("age_limit"), DEFAULT_CONFIG["age_limit"], minimum = 0)
	normalized_config["check_frequency"] = normalize_integer(raw_config.get("check_frequency"), DEFAULT_CONFIG["check_frequency"], minimum = 1)
	normalized_config["max_files"] = normalize_integer(raw_config.get("max_files"), DEFAULT_CONFIG["max_files"], minimum = 0)
	normalized_config["enable_logging"] = normalize_boolean(raw_config.get("enable_logging"), DEFAULT_CONFIG["enable_logging"])
	normalized_config["protect_active_files"] = normalize_boolean(raw_config.get("protect_active_files"), DEFAULT_CONFIG["protect_active_files"])
	normalized_config["repair_missing_files"] = normalize_boolean(raw_config.get("repair_missing_files"), DEFAULT_CONFIG["repair_missing_files"])
	normalized_config["trash_destination"] = normalize_string(raw_config.get("trash_destination"), DEFAULT_CONFIG["trash_destination"])
	normalized_config["cleaning_paths"] = normalize_cleaning_paths(raw_config.get("cleaning_paths"))
	normalized_config["whitelist"] = normalize_file_name_list(get_config_value(raw_config, "whitelist"), DEFAULT_CONFIG["whitelist"])
	normalized_config["blacklist"] = normalize_file_name_list(get_config_value(raw_config, "blacklist"), DEFAULT_CONFIG["blacklist"])
	return normalized_config


def read_json_file(path):
	try:
		with open(path, "r", encoding = "utf-8") as config_file:
			raw_config = json.load(config_file)
			return raw_config if isinstance(raw_config, dict) else None
	except FileNotFoundError:
		return None
	except (OSError, json.JSONDecodeError) as error:
		log_message(f"Config read failed for '{path}': {error}")
		return None


def write_config(config_to_write):
	os.makedirs(RUNTIME_CONFIG_DIRECTORY, exist_ok = True)
	temp_path = f"{RUNTIME_CONFIG_PATH}.tmp"

	with open(temp_path, "w", encoding = "utf-8") as config_file:
		json.dump(config_to_write, config_file, indent = "\t")

	os.replace(temp_path, RUNTIME_CONFIG_PATH)


def load_config():
	runtime_config = read_json_file(RUNTIME_CONFIG_PATH)
	if runtime_config is not None:
		normalized_config = normalize_config(runtime_config)
		if normalized_config != runtime_config:
			write_config(normalized_config)
		return normalized_config

	legacy_config = read_json_file(LEGACY_CONFIG_PATH)
	if legacy_config is not None:
		normalized_config = normalize_config(legacy_config)
		write_config(normalized_config)
		log_message(f"Migrated legacy config from '{LEGACY_CONFIG_PATH}' to '{RUNTIME_CONFIG_PATH}'.")
		return normalized_config

	normalized_config = normalize_config(None)
	write_config(normalized_config)
	return normalized_config


config = load_config()


def build_placeholder_png(size = PLACEHOLDER_SIZE, gray = PLACEHOLDER_GRAY):
	"""A flat gray PNG, built with the standard library so it ships as code."""
	scanlines = b"".join(b"\x00" + bytes([gray]) * size for _ in range(size))

	def chunk(tag, payload):
		crc = zlib.crc32(tag + payload) & 0xffffffff
		return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

	header = struct.pack(">IIBBBBB", size, size, 8, 0, 0, 0, 0)
	return (
		b"\x89PNG\r\n\x1a\n"
		+ chunk(b"IHDR", header)
		+ chunk(b"IDAT", zlib.compress(scanlines, 9))
		+ chunk(b"IEND", b"")
	)


def get_placeholder_image_path():
	return os.path.join(folder_paths.get_input_directory(), PLACEHOLDER_FILE_NAME)


def ensure_placeholder_image():
	"""Keep the repair target on disk, and never let the cleaner take it."""
	placeholder_path = get_placeholder_image_path()

	try:
		if os.path.isfile(placeholder_path):
			return

		os.makedirs(os.path.dirname(placeholder_path), exist_ok = True)
		with open(placeholder_path, "wb") as placeholder_file:
			placeholder_file.write(build_placeholder_png())
	except OSError as error:
		log_message(f"Unable to write '{placeholder_path}': {error}")


ensure_placeholder_image()


def get_config_snapshot():
	with config_lock:
		return dict(config)


def update_config(new_config):
	global config

	merged_config = get_config_snapshot()
	merged_config.update(new_config)
	normalized_config = normalize_config(merged_config)

	with config_lock:
		write_config(normalized_config)
		config = normalized_config

	return dict(normalized_config)


# API endpoints for settings
@PromptServer.instance.routes.get("/temp_file_cleaner/settings")
async def get_settings(request):
	return web.json_response(get_config_snapshot())


@PromptServer.instance.routes.post("/temp_file_cleaner/settings")
async def set_settings(request):
	data = None

	try:
		if request.can_read_body:
			body = await request.text()
			if body and body.strip():
				data = json.loads(body)
	except json.JSONDecodeError:
		return web.json_response({"status": "error", "message": "Invalid JSON body."}, status=400)

	if data is None:
		return web.json_response({"status": "ok", "config": get_config_snapshot()})

	if not isinstance(data, dict):
		return web.json_response({"status": "error", "message": "Settings payload must be a JSON object."}, status=400)

	updated_config = update_config(data)
	return web.json_response({"status": "ok", "config": updated_config})


def normalize_absolute_path(path):
	return os.path.normcase(os.path.abspath(path))


def normalize_protected_file_reference(file_reference, owner_id = ""):
	if not isinstance(file_reference, str):
		return None

	file_reference = file_reference.strip()
	if not file_reference or len(file_reference) > MAX_PROTECTED_FILE_REFERENCE_LENGTH:
		return None

	if file_reference.startswith("blake3:"):
		if resolve_hash_to_path is None:
			return None

		resolved_file = resolve_hash_to_path(file_reference, owner_id = owner_id)
		if resolved_file is None:
			return None
		file_path = resolved_file.abs_path
	else:
		try:
			file_path = folder_paths.get_annotated_filepath(file_reference)
		except (TypeError, ValueError):
			return None

	file_path = normalize_absolute_path(file_path)
	try:
		if os.path.commonpath([normalize_absolute_path(BASE_DIRECTORY), file_path]) != normalize_absolute_path(BASE_DIRECTORY):
			return None
	except ValueError:
		return None

	return file_path


def update_client_protected_files(client_id, file_references, owner_id = ""):
	protected_paths = set()
	for file_reference in file_references:
		protected_path = normalize_protected_file_reference(file_reference, owner_id)
		if protected_path:
			protected_paths.add(protected_path)

	with protected_files_lock:
		if protected_paths:
			protected_files_by_client[client_id] = (time.monotonic(), protected_paths)
		else:
			protected_files_by_client.pop(client_id, None)


def get_missing_file_references(file_references, owner_id = ""):
	"""References that resolve to a location on disk but no longer exist."""
	missing_references = []

	for file_reference in file_references:
		if not isinstance(file_reference, str):
			continue

		file_path = normalize_protected_file_reference(file_reference, owner_id)
		if file_path is None or os.path.isfile(file_path):
			continue

		missing_references.append(file_reference.strip())

	return missing_references


@PromptServer.instance.routes.post("/temp_file_cleaner/missing-files")
async def report_missing_files(request):
	try:
		body = await request.text()
		data = json.loads(body) if body and body.strip() else None
	except json.JSONDecodeError:
		return web.json_response({"status": "error", "message": "Invalid JSON body."}, status = 400)

	if not isinstance(data, dict):
		return web.json_response({"status": "error", "message": "Missing files payload must be a JSON object."}, status = 400)

	file_references = data.get("files")
	if not isinstance(file_references, list) or len(file_references) > MAX_PROTECTED_FILES_PER_CLIENT:
		return web.json_response({"status": "error", "message": "Invalid files list."}, status = 400)

	owner_id = PromptServer.instance.user_manager.get_request_user_id(request)
	return web.json_response({"status": "ok", "missing": get_missing_file_references(file_references, owner_id)})


@PromptServer.instance.routes.post("/temp_file_cleaner/protected-files")
async def set_protected_files(request):
	try:
		body = await request.text()
		data = json.loads(body) if body and body.strip() else None
	except json.JSONDecodeError:
		return web.json_response({"status": "error", "message": "Invalid JSON body."}, status = 400)

	if not isinstance(data, dict):
		return web.json_response({"status": "error", "message": "Protected files payload must be a JSON object."}, status = 400)

	client_id = data.get("client_id")
	file_references = data.get("files")
	if not isinstance(client_id, str) or not client_id.strip() or len(client_id) > 128:
		return web.json_response({"status": "error", "message": "Invalid client id."}, status = 400)
	if not isinstance(file_references, list) or len(file_references) > MAX_PROTECTED_FILES_PER_CLIENT:
		return web.json_response({"status": "error", "message": "Invalid protected files list."}, status = 400)

	owner_id = PromptServer.instance.user_manager.get_request_user_id(request)
	update_client_protected_files(client_id.strip(), file_references, owner_id)
	return web.json_response({"status": "ok"})


def resolve_relative_directory(relative_path):
	target_directory = os.path.abspath(os.path.join(BASE_DIRECTORY, relative_path.replace("/", os.sep)))

	try:
		if os.path.commonpath([BASE_DIRECTORY, target_directory]) != BASE_DIRECTORY:
			return None
	except ValueError:
		return None

	return target_directory


def ensure_unique_path(path):
	if not os.path.exists(path):
		return path

	base_name, extension = os.path.splitext(path)
	suffix = 1

	while True:
		candidate_path = f"{base_name}_{suffix}{extension}"
		if not os.path.exists(candidate_path):
			return candidate_path
		suffix += 1


def build_trash_path(file_path, trash_destination):
	try:
		relative_source_path = os.path.relpath(file_path, BASE_DIRECTORY)
	except ValueError:
		relative_source_path = os.path.basename(file_path)

	relative_source_path = os.path.normpath(relative_source_path)
	if relative_source_path == ".." or relative_source_path.startswith(f"..{os.sep}"):
		relative_source_path = os.path.basename(file_path)

	target_path = os.path.abspath(os.path.join(trash_destination, relative_source_path))
	if os.path.normcase(target_path) == os.path.normcase(os.path.abspath(file_path)):
		target_path = os.path.abspath(os.path.join(trash_destination, "__trashed", relative_source_path))

	return ensure_unique_path(target_path)


def clean_file(file_path, current_config):
	trash_destination = current_config["trash_destination"]

	if trash_destination:
		try:
			trash_path = build_trash_path(file_path, trash_destination)
			os.makedirs(os.path.dirname(trash_path), exist_ok = True)
			os.replace(file_path, trash_path)
			log_message(f"Moved file to trash: {trash_path}", current_config["enable_logging"])
		except OSError as error:
			log_message(f"Error moving '{os.path.basename(file_path)}' to trash: {error}", current_config["enable_logging"])
	else:
		try:
			os.remove(file_path)
			log_message(f"Deleted file: {file_path}", current_config["enable_logging"])
		except OSError as error:
			log_message(f"Error deleting '{file_path}': {error}", current_config["enable_logging"])


def get_prompt_file_references(prompt):
	file_references = []
	if not isinstance(prompt, dict):
		return file_references

	for node_data in prompt.values():
		if not isinstance(node_data, dict):
			continue

		input_name = PROTECTED_NODE_INPUTS.get(node_data.get("class_type"))
		inputs = node_data.get("inputs")
		if not input_name or not isinstance(inputs, dict):
			continue

		input_value = inputs.get(input_name)
		if isinstance(input_value, str):
			file_references.append(input_value)
		elif isinstance(input_value, list) and all(isinstance(value, str) for value in input_value):
			file_references.extend(input_value)

	return file_references


def get_queue_protected_paths():
	protected_paths = set()
	running_items, queued_items = PromptServer.instance.prompt_queue.get_current_queue_volatile()

	for queue_item in running_items + queued_items:
		if len(queue_item) < 3:
			continue

		for file_reference in get_prompt_file_references(queue_item[2]):
			protected_path = normalize_protected_file_reference(file_reference)
			if protected_path:
				protected_paths.add(protected_path)

	return protected_paths


def get_protected_paths(current_config):
	if not current_config["protect_active_files"]:
		return set()

	now = time.monotonic()
	protected_paths = set()

	with protected_files_lock:
		expired_client_ids = []
		for client_id, (updated_at, client_paths) in protected_files_by_client.items():
			if (now - updated_at) > PROTECTED_FILE_LEASE_SECONDS:
				expired_client_ids.append(client_id)
				continue

			protected_paths.update(client_paths)

		for client_id in expired_client_ids:
			protected_files_by_client.pop(client_id, None)

	protected_paths.update(get_queue_protected_paths())
	return protected_paths


def get_directory_files(target_directory, current_config, protected_paths):
	files = []
	whitelisted_file_names = set(file_name.casefold() for file_name in split_file_names(current_config["whitelist"]))
	blacklisted_file_names = set(file_name.casefold() for file_name in split_file_names(current_config["blacklist"]))

	try:
		with os.scandir(target_directory) as entries:
			for entry in entries:
				try:
					if not entry.is_file(follow_symlinks = False):
						continue
					if normalize_absolute_path(entry.path) in protected_paths:
						continue

					file_name_key = entry.name.casefold()
					if file_name_key in blacklisted_file_names:
						continue

					if file_name_key == PLACEHOLDER_FILE_NAME.casefold():
						continue

					if whitelisted_file_names and file_name_key not in whitelisted_file_names:
						continue

					stat_result = entry.stat(follow_symlinks = False)
					files.append((entry.path, stat_result.st_mtime))
				except OSError as error:
					log_message(f"Skipping inaccessible path '{entry.path}': {error}", current_config["enable_logging"])
	except OSError as error:
		log_message(f"Unable to scan '{target_directory}': {error}", current_config["enable_logging"])

	return files


def clean_directory(relative_path, target_directory, current_config, protected_paths):
	if not os.path.isdir(target_directory):
		log_message(f"Directory does not exist, skipping '{relative_path}': {target_directory}", current_config["enable_logging"])
		return

	now = time.time()
	files = get_directory_files(target_directory, current_config, protected_paths)

	if current_config["age_limit"] > 0:
		max_file_age = current_config["age_limit"] * 60
		for file_path, modified_time in files:
			if (now - modified_time) > max_file_age:
				clean_file(file_path, current_config)

		files = [(file_path, modified_time) for file_path, modified_time in files if os.path.exists(file_path)]

	if current_config["max_files"] > 0 and len(files) > current_config["max_files"]:
		files.sort(key = lambda file_info: file_info[1])
		files_to_delete = len(files) - current_config["max_files"]
		for file_path, _ in files[:files_to_delete]:
			clean_file(file_path, current_config)


def run_cleanup_cycle(current_config):
	target_paths = split_cleaning_paths(current_config["cleaning_paths"])
	if not target_paths:
		log_message("No valid cleaning paths configured. Skipping cleanup cycle.", current_config["enable_logging"])
		return

	log_message(f"Running cleanup for: {', '.join(target_paths)}", current_config["enable_logging"])
	protected_paths = get_protected_paths(current_config)

	for relative_path in target_paths:
		target_directory = resolve_relative_directory(relative_path)
		if not target_directory:
			log_message(f"Skipping invalid relative path: {relative_path}", current_config["enable_logging"])
			continue

		clean_directory(relative_path, target_directory, current_config, protected_paths)


def cleanup_loop():
	initial_config = get_config_snapshot()
	log_message("Starting cleanup thread.", initial_config["enable_logging"])

	while True:
		current_config = get_config_snapshot()
		time.sleep(current_config["check_frequency"] * 60)
		current_config = get_config_snapshot()

		try:
			run_cleanup_cycle(current_config)
		except Exception as error:
			log_message(f"Cleanup cycle failed: {error}", current_config["enable_logging"])


# Start the cleanup thread
thread = threading.Thread(target = cleanup_loop, daemon = True)
thread.start()

# No nodes defined
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"
