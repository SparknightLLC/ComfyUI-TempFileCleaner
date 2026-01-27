import os
import time
import threading
import json
import folder_paths
from aiohttp import web
from server import PromptServer

extension_path = os.path.dirname(os.path.realpath(__file__))
config_path = os.path.join(extension_path, "config.json")

DEFAULT_CONFIG = {
	"age_limit": 30,
	"check_frequency": 5,
	"max_files": 100,
	"enable_logging": True,
	"trash_destination": ""
}


def normalize_config(raw_config):
	normalized_config = dict(DEFAULT_CONFIG)
	if isinstance(raw_config, dict):
		for key in DEFAULT_CONFIG:
			if key in raw_config:
				normalized_config[key] = raw_config[key]
	return normalized_config


def write_config(config_to_write):
	with open(config_path, "w") as f:
		json.dump(config_to_write, f)


def load_config():
	if os.path.exists(config_path):
		try:
			with open(config_path, "r") as f:
				return normalize_config(json.load(f))
		except (OSError, json.JSONDecodeError) as e:
			print(f"TempFileCleaner config read failed, resetting to defaults: {e}")

	normalized_config = normalize_config(None)
	write_config(normalized_config)
	return normalized_config


config = load_config()


def update_config(new_config):
	global config
	normalized_config = normalize_config(new_config)
	write_config(normalized_config)
	config = normalized_config


# API endpoints for settings
@PromptServer.instance.routes.get("/temp_file_cleaner/settings")
async def get_settings(request):
	return web.json_response(config)


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
		return web.json_response({"status": "ok", "config": config})

	update_config(data)
	return web.json_response({"status": "ok"})


def clean_file(file_path):
	if config["trash_destination"]:
		# move the file to trash_destination instead of deleting
		try:
			trash_path = os.path.join(config["trash_destination"], os.path.basename(file_path))
			os.makedirs(config["trash_destination"], exist_ok=True)
			os.rename(file_path, trash_path)
			if config["enable_logging"]:
				print(f"Moved temp file to trash: {trash_path}")
		except Exception as e:
			if config["enable_logging"]:
				print(f"Error moving {os.path.basename(file_path)} to trash: {e}")
	else:
		try:
			os.remove(file_path)
			if config["enable_logging"]:
				print(f"Deleted temp file: {os.path.basename(file_path)}")
		except Exception as e:
			if config["enable_logging"]:
				print(f"Error deleting {os.path.basename(file_path)}: {e}")


def cleanup_temp():
	if config["enable_logging"]:
		print("Starting temp file cleanup thread...")

	while True:
		time.sleep(config["check_frequency"] * 60)
		print("Running temp file cleanup...")

		temp_dir = folder_paths.get_temp_directory()

		if not os.path.exists(temp_dir):
			if config["enable_logging"]:
				print(f"Temp directory does not exist: {temp_dir}")
				print("Waiting for next check...")
			continue

		now = time.time()
		files = []
		for f in os.listdir(temp_dir):
			file_path = os.path.join(temp_dir, f)
			if os.path.isfile(file_path):
				mtime = os.path.getmtime(file_path)
				age = now - mtime
				files.append((file_path, mtime, age))

		if config["age_limit"] > 0:
			# Delete files older than age_limit
			for file_path, mtime, age in files:
				if age > config["age_limit"] * 60:
					clean_file(file_path)

			# Refresh files list after deletions
			files = [(fp, mt, now - mt) for fp, mt, _ in files if os.path.exists(fp)]

		if config["max_files"] > 0:
			# Enforce max_files limit by deleting oldest
			if len(files) > config["max_files"]:
				files.sort(key=lambda x: x[1])  # Sort by mtime (oldest first)
				to_delete = len(files) - config["max_files"]
				for i in range(to_delete):
					file_path = files[i][0]
					clean_file(file_path)


# Start the cleanup thread
thread = threading.Thread(target=cleanup_temp, daemon=True)
thread.start()

# No nodes defined
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "./web"
