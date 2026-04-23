import json
import os
import posixpath
import threading
import time

import folder_paths
from aiohttp import web
from server import PromptServer

EXTENSION_PATH = os.path.dirname(os.path.realpath(__file__))
LEGACY_CONFIG_PATH = os.path.join(EXTENSION_PATH, "config.json")
RUNTIME_CONFIG_DIRECTORY = folder_paths.get_system_user_directory("temp_file_cleaner")
RUNTIME_CONFIG_PATH = os.path.join(RUNTIME_CONFIG_DIRECTORY, "settings.json")
BASE_DIRECTORY = os.path.abspath(folder_paths.base_path)
LOG_PREFIX = "[TempFileCleaner]"

DEFAULT_CONFIG = {
	"age_limit": 120,
	"check_frequency": 10,
	"max_files": 100,
	"enable_logging": True,
	"trash_destination": "",
	"cleaning_paths": "temp"
}

config_lock = threading.RLock()


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


def normalize_config(raw_config):
	normalized_config = dict(DEFAULT_CONFIG)
	if not isinstance(raw_config, dict):
		return normalized_config

	normalized_config["age_limit"] = normalize_integer(raw_config.get("age_limit"), DEFAULT_CONFIG["age_limit"], minimum = 0)
	normalized_config["check_frequency"] = normalize_integer(raw_config.get("check_frequency"), DEFAULT_CONFIG["check_frequency"], minimum = 1)
	normalized_config["max_files"] = normalize_integer(raw_config.get("max_files"), DEFAULT_CONFIG["max_files"], minimum = 0)
	normalized_config["enable_logging"] = normalize_boolean(raw_config.get("enable_logging"), DEFAULT_CONFIG["enable_logging"])
	normalized_config["trash_destination"] = normalize_string(raw_config.get("trash_destination"), DEFAULT_CONFIG["trash_destination"])
	normalized_config["cleaning_paths"] = normalize_cleaning_paths(raw_config.get("cleaning_paths"))
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


def get_directory_files(target_directory, current_config):
	files = []

	try:
		with os.scandir(target_directory) as entries:
			for entry in entries:
				try:
					if not entry.is_file(follow_symlinks = False):
						continue

					stat_result = entry.stat(follow_symlinks = False)
					files.append((entry.path, stat_result.st_mtime))
				except OSError as error:
					log_message(f"Skipping inaccessible path '{entry.path}': {error}", current_config["enable_logging"])
	except OSError as error:
		log_message(f"Unable to scan '{target_directory}': {error}", current_config["enable_logging"])

	return files


def clean_directory(relative_path, target_directory, current_config):
	if not os.path.isdir(target_directory):
		log_message(f"Directory does not exist, skipping '{relative_path}': {target_directory}", current_config["enable_logging"])
		return

	now = time.time()
	files = get_directory_files(target_directory, current_config)

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

	for relative_path in target_paths:
		target_directory = resolve_relative_directory(relative_path)
		if not target_directory:
			log_message(f"Skipping invalid relative path: {relative_path}", current_config["enable_logging"])
			continue

		clean_directory(relative_path, target_directory, current_config)


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
