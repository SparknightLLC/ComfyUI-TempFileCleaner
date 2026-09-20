import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "comfy.temp_file_cleaner";
const SETTINGS_ENDPOINT = "/temp_file_cleaner/settings";
const PROTECTED_FILES_ENDPOINT = "/temp_file_cleaner/protected-files";
const MISSING_FILES_ENDPOINT = "/temp_file_cleaner/missing-files";
const MISSING_MEDIA_STORE_ID = "missingMedia";
const EXECUTION_ERROR_STORE_ID = "executionError";
const SETTINGS_PANEL_LABEL = "Temp File Cleaner";
const SETTINGS_SECTION_LABEL = "General";
const SETTINGS_INSTALL_FLAG = "__temp_file_cleaner_settings_installed";
const PROTECTION_HEARTBEAT_INTERVAL = 30000;
const PROTECTION_SYNC_DELAY = 250;
const PROTECTED_NODE_TYPES = new Set(["LoadImage", "LoadImageMask", "LoadImageOutput"]);
// Must match PLACEHOLDER_FILE_NAME in __init__.py. The server writes the image
// and never cleans it, so a repaired node always points at something loadable.
const PLACEHOLDER_IMAGE = "temp_file_cleaner_placeholder.png";
const REPAIRABLE_NODE_INPUTS = new Map([
	["LoadImage", "image"],
	["LoadImageMask", "image"],
	["LoadImageOutput", "image"],
	["PreviewImage", "image"]
]);
const MISSING_FILE_PATTERN = /no such file|not found|cannot identify|invalid image|failed to load|couldn't be loaded|could not be loaded|does not exist|lacks file/i;

const SETTING_IDS = {
	age_limit: "temp_file_cleaner.age_limit",
	check_frequency: "temp_file_cleaner.check_frequency",
	max_files: "temp_file_cleaner.max_files",
	enable_logging: "temp_file_cleaner.enable_logging",
	protect_active_files: "temp_file_cleaner.protect_active_files",
	repair_missing_files: "temp_file_cleaner.repair_missing_files",
	trash_destination: "temp_file_cleaner.trash_destination",
	cleaning_paths: "temp_file_cleaner.cleaning_paths",
	whitelist: "temp_file_cleaner.whitelist",
	blacklist: "temp_file_cleaner.blacklist"
};

const DEFAULT_SETTINGS = {
	age_limit: 120,
	check_frequency: 10,
	max_files: 100,
	enable_logging: true,
	protect_active_files: true,
	repair_missing_files: true,
	trash_destination: "",
	cleaning_paths: "temp",
	whitelist: "",
	blacklist: "bedroom.mp4,example_image.jpg,groceries.jpg,image.png"
};

const protection_client_id = globalThis.crypto?.randomUUID?.()
	?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let protect_active_files = DEFAULT_SETTINGS.protect_active_files;
let repair_missing_files = DEFAULT_SETTINGS.repair_missing_files;
let protection_tracking_started = false;
let protection_sync_timeout = null;
let protection_sync_promise = Promise.resolve();
/** Repairs made while a queue request was being validated, so it can retry. */
let repairs_during_queue = 0;

function build_setting_category(label)
{
	return [SETTINGS_PANEL_LABEL, SETTINGS_SECTION_LABEL, label];
}

function normalize_integer(value, fallback, minimum = 0)
{
	const parsed_value = Number(value);
	if (!Number.isFinite(parsed_value))
	{
		return fallback;
	}

	return Math.max(minimum, Math.trunc(parsed_value));
}

function normalize_boolean(value, fallback)
{
	if (typeof value === "boolean")
	{
		return value;
	}

	if (typeof value === "number")
	{
		return value !== 0;
	}

	if (typeof value === "string")
	{
		const normalized_value = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized_value))
		{
			return true;
		}

		if (["0", "false", "no", "off", ""].includes(normalized_value))
		{
			return false;
		}
	}

	return fallback;
}

function normalize_string(value, fallback)
{
	return typeof value === "string"
		? value.trim()
		: fallback;
}

function normalize_relative_path(value)
{
	if (typeof value !== "string")
	{
		return null;
	}

	const candidate_path = value.trim().replaceAll("\\", "/");
	if (!candidate_path)
	{
		return null;
	}

	if (candidate_path.startsWith("/") || /^[A-Za-z]:/.test(candidate_path))
	{
		return null;
	}

	const normalized_segments = [];
	for (const segment of candidate_path.split("/"))
	{
		const normalized_segment = segment.trim();
		if (!normalized_segment || normalized_segment === ".")
		{
			continue;
		}

		if (normalized_segment === "..")
		{
			return null;
		}

		normalized_segments.push(normalized_segment);
	}

	return normalized_segments.length > 0
		? normalized_segments.join("/")
		: null;
}

function normalize_cleaning_paths(value)
{
	if (typeof value !== "string")
	{
		return DEFAULT_SETTINGS.cleaning_paths;
	}

	const normalized_paths = [];
	const seen_paths = new Set();

	for (const raw_path of value.split(","))
	{
		const normalized_path = normalize_relative_path(raw_path);
		if (!normalized_path || seen_paths.has(normalized_path))
		{
			continue;
		}

		seen_paths.add(normalized_path);
		normalized_paths.push(normalized_path);
	}

	return normalized_paths.length > 0
		? normalized_paths.join(",")
		: DEFAULT_SETTINGS.cleaning_paths;
}

function normalize_file_name_list(value, fallback = "")
{
	if (typeof value !== "string")
	{
		return fallback;
	}

	const normalized_file_names = [];
	const seen_file_names = new Set();

	for (const raw_file_name of value.split(","))
	{
		const normalized_file_name = raw_file_name.trim();
		if (!normalized_file_name || normalized_file_name === "." || normalized_file_name === "..")
		{
			continue;
		}

		if (normalized_file_name.includes("/") || normalized_file_name.includes("\\"))
		{
			continue;
		}

		const file_name_key = normalized_file_name.toLowerCase();
		if (seen_file_names.has(file_name_key))
		{
			continue;
		}

		seen_file_names.add(file_name_key);
		normalized_file_names.push(normalized_file_name);
	}

	return normalized_file_names.length > 0
		? normalized_file_names.join(",")
		: "";
}

function normalize_settings(raw_settings)
{
	return {
		age_limit: normalize_integer(raw_settings?.age_limit, DEFAULT_SETTINGS.age_limit, 0),
		check_frequency: normalize_integer(raw_settings?.check_frequency, DEFAULT_SETTINGS.check_frequency, 1),
		max_files: normalize_integer(raw_settings?.max_files, DEFAULT_SETTINGS.max_files, 0),
		enable_logging: normalize_boolean(raw_settings?.enable_logging, DEFAULT_SETTINGS.enable_logging),
		protect_active_files: normalize_boolean(raw_settings?.protect_active_files, DEFAULT_SETTINGS.protect_active_files),
		repair_missing_files: normalize_boolean(raw_settings?.repair_missing_files, DEFAULT_SETTINGS.repair_missing_files),
		trash_destination: normalize_string(raw_settings?.trash_destination, DEFAULT_SETTINGS.trash_destination),
		cleaning_paths: normalize_cleaning_paths(raw_settings?.cleaning_paths),
		whitelist: normalize_file_name_list(raw_settings?.whitelist, DEFAULT_SETTINGS.whitelist),
		blacklist: normalize_file_name_list(raw_settings?.blacklist, DEFAULT_SETTINGS.blacklist)
	};
}

function get_settings_access()
{
	const extension_setting = app?.extensionManager?.setting;
	if (extension_setting && typeof extension_setting.get === "function")
	{
		return {
			add_setting: app?.ui?.settings?.addSetting?.bind(app.ui.settings) ?? null,
			get: (id, fallback) =>
			{
				const value = extension_setting.get(id);
				return value === undefined ? fallback : value;
			}
		};
	}

	const ui_settings = app?.ui?.settings;
	if (ui_settings && typeof ui_settings.getSettingValue === "function")
	{
		return {
			add_setting: ui_settings.addSetting?.bind(ui_settings) ?? null,
			get: (id, fallback) => ui_settings.getSettingValue(id, fallback)
		};
	}

	return null;
}

async function fetch_server_settings()
{
	try
	{
		const response = await fetch(SETTINGS_ENDPOINT);
		if (response.ok)
		{
			return normalize_settings(await response.json());
		}
	}
	catch (error)
	{
		console.error("Error fetching Temp File Cleaner settings:", error);
	}

	return { ...DEFAULT_SETTINGS };
}

async function save_server_settings(settings)
{
	const normalized_settings = normalize_settings(settings);

	try
	{
		await fetch(SETTINGS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(normalized_settings)
		});
	}
	catch (error)
	{
		console.error("Error saving Temp File Cleaner settings:", error);
	}

	return normalized_settings;
}

function read_ui_settings(settings_access, fallback_settings)
{
	return normalize_settings({
		age_limit: settings_access.get(SETTING_IDS.age_limit, fallback_settings.age_limit),
		check_frequency: settings_access.get(SETTING_IDS.check_frequency, fallback_settings.check_frequency),
		max_files: settings_access.get(SETTING_IDS.max_files, fallback_settings.max_files),
		enable_logging: settings_access.get(SETTING_IDS.enable_logging, fallback_settings.enable_logging),
		protect_active_files: settings_access.get(SETTING_IDS.protect_active_files, fallback_settings.protect_active_files),
		repair_missing_files: settings_access.get(SETTING_IDS.repair_missing_files, fallback_settings.repair_missing_files),
		trash_destination: settings_access.get(SETTING_IDS.trash_destination, fallback_settings.trash_destination),
		cleaning_paths: settings_access.get(SETTING_IDS.cleaning_paths, fallback_settings.cleaning_paths),
		whitelist: settings_access.get(SETTING_IDS.whitelist, fallback_settings.whitelist),
		blacklist: settings_access.get(SETTING_IDS.blacklist, fallback_settings.blacklist)
	});
}

function add_protected_file_reference(protected_files, value)
{
	if (typeof value === "string" && value.trim())
	{
		protected_files.add(value.trim());
	}
	else if (Array.isArray(value))
	{
		for (const item of value)
		{
			add_protected_file_reference(protected_files, item);
		}
	}
}

function collect_live_graph_protected_files(graph, protected_files, node_types = PROTECTED_NODE_TYPES, visited_graphs = new Set())
{
	if (!graph || visited_graphs.has(graph))
	{
		return;
	}

	visited_graphs.add(graph);
	for (const node of graph._nodes ?? [])
	{
		const node_type = node?.comfyClass ?? node?.type;
		if (!node_types.has(node_type))
		{
			continue;
		}

		const image_widget = node.widgets?.find((widget) => widget.name === "image");
		add_protected_file_reference(protected_files, image_widget?.value);
	}

	const subgraphs = graph._subgraphs ?? graph.subgraphs;
	if (subgraphs && typeof subgraphs.values === "function")
	{
		for (const subgraph of subgraphs.values())
		{
			collect_live_graph_protected_files(subgraph, protected_files, node_types, visited_graphs);
		}
	}
}

function collect_serialized_graph_protected_files(graph_data, protected_files)
{
	if (!graph_data || typeof graph_data !== "object")
	{
		return;
	}

	for (const node of graph_data.nodes ?? [])
	{
		if (!PROTECTED_NODE_TYPES.has(node?.type))
		{
			continue;
		}

		const widget_values = node.widgets_values;
		if (Array.isArray(widget_values))
		{
			add_protected_file_reference(protected_files, widget_values[0]);
		}
		else
		{
			add_protected_file_reference(protected_files, widget_values?.image);
		}
	}

	for (const subgraph of graph_data.definitions?.subgraphs ?? [])
	{
		collect_serialized_graph_protected_files(subgraph, protected_files);
	}
}

async function get_open_workflow_state(workflow)
{
	if (workflow?.activeState)
	{
		return workflow.activeState;
	}

	if (typeof workflow?.content !== "string" && typeof workflow?.load === "function")
	{
		try
		{
			await workflow.load();
		}
		catch
		{
			return null;
		}
	}

	if (workflow?.activeState)
	{
		return workflow.activeState;
	}

	if (typeof workflow?.content !== "string")
	{
		return null;
	}

	try
	{
		return JSON.parse(workflow.content);
	}
	catch
	{
		return null;
	}
}

async function get_protected_file_references()
{
	const protected_files = new Set();
	collect_live_graph_protected_files(app?.rootGraph ?? app?.graph, protected_files);

	for (const workflow of app?.extensionManager?.workflow?.openWorkflows ?? [])
	{
		collect_serialized_graph_protected_files(await get_open_workflow_state(workflow), protected_files);
	}

	return [...protected_files];
}

function sync_protected_files()
{
	protection_sync_promise = protection_sync_promise.then(async () =>
	{
		const file_references = protect_active_files
			? await get_protected_file_references()
			: [];

		try
		{
			await fetch(PROTECTED_FILES_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: protection_client_id,
					files: file_references
				})
			});
		}
		catch (error)
		{
			console.error("Error updating Temp File Cleaner protected files:", error);
		}
	});

	return protection_sync_promise;
}

function schedule_protected_files_sync(delay = PROTECTION_SYNC_DELAY)
{
	if (protection_sync_timeout !== null)
	{
		clearTimeout(protection_sync_timeout);
	}

	protection_sync_timeout = setTimeout(() =>
	{
		protection_sync_timeout = null;
		sync_protected_files();
	}, delay);
}

function set_active_file_protection(enabled)
{
	protect_active_files = enabled;
	schedule_protected_files_sync(0);
}

function set_file_repair(enabled)
{
	repair_missing_files = enabled;
}

function start_active_file_protection()
{
	if (protection_tracking_started)
	{
		return;
	}

	protection_tracking_started = true;
	setInterval(sync_protected_files, PROTECTION_HEARTBEAT_INTERVAL);
	schedule_protected_files_sync(0);
}

function watch_protected_node(node)
{
	const node_type = node?.comfyClass ?? node?.type;
	if (!PROTECTED_NODE_TYPES.has(node_type))
	{
		return;
	}

	const on_widget_changed = node.onWidgetChanged;
	node.onWidgetChanged = function(widget_name)
	{
		const result = on_widget_changed?.apply(this, arguments);
		if (widget_name === "image")
		{
			schedule_protected_files_sync();
		}

		return result;
	};

	const on_removed = node.onRemoved;
	node.onRemoved = function()
	{
		const result = on_removed?.apply(this, arguments);
		schedule_protected_files_sync();
		return result;
	};
}

function get_node_type(node)
{
	return node?.comfyClass ?? node?.type;
}

/** The `image` field of a node whose input points at a cleaned file. */
function get_repairable_widget(node)
{
	const input_name = REPAIRABLE_NODE_INPUTS.get(get_node_type(node));
	return input_name ? node.widgets?.find((widget) => widget.name === input_name) : undefined;
}

function get_node_image_reference(node)
{
	const widget = get_repairable_widget(node);
	return typeof widget?.value === "string" ? widget.value.trim() : "";
}

function for_each_graph_node(graph, callback, visited_graphs = new Set())
{
	if (!graph || visited_graphs.has(graph))
	{
		return;
	}

	visited_graphs.add(graph);
	for (const node of graph._nodes ?? [])
	{
		callback(node);
	}

	const subgraphs = graph._subgraphs ?? graph.subgraphs;
	if (subgraphs && typeof subgraphs.values === "function")
	{
		for (const subgraph of subgraphs.values())
		{
			for_each_graph_node(subgraph, callback, visited_graphs);
		}
	}
}

function notify_repair(node, previous_reference)
{
	const node_title = node.title || get_node_type(node) || "node";
	const message = `"${previous_reference}" is gone, so ${node_title} was reset to ${PLACEHOLDER_IMAGE}. ` +
		"Protect the file or pick another one before running again.";
	console.warn(`Temp File Cleaner: ${message}`);

	try
	{
		app?.extensionManager?.toast?.add?.({
			severity: "warn",
			summary: "Temp File Cleaner repaired a missing image",
			detail: message,
			life: 10000
		});
	}
	catch (error)
	{
	}
}

/** Point a node at the placeholder, so a cleaned file cannot fail the run. */
function apply_placeholder_image(node)
{
	if (!repair_missing_files)
	{
		return false;
	}

	const widget = get_repairable_widget(node);
	const previous_reference = get_node_image_reference(node);
	if (!widget || !previous_reference || previous_reference === PLACEHOLDER_IMAGE)
	{
		return false;
	}

	widget.value = PLACEHOLDER_IMAGE;
	widget.callback?.(PLACEHOLDER_IMAGE, app?.canvas, node, app?.canvas?.graph_mouse, undefined);
	node.graph?.setDirtyCanvas?.(true, true);
	notify_repair(node, previous_reference);
	return true;
}

function repair_nodes(matches)
{
	let repaired = 0;
	for_each_graph_node(app?.rootGraph ?? app?.graph, (node) =>
	{
		if (matches(get_node_image_reference(node)))
		{
			if (apply_placeholder_image(node))
			{
				repaired += 1;
			}
		}
	});

	if (repaired > 0)
	{
		schedule_protected_files_sync();
	}

	return repaired;
}

function repair_missing_file_references(missing_references)
{
	if (!Array.isArray(missing_references) || missing_references.length === 0)
	{
		return 0;
	}

	const missing = new Set(missing_references.map((reference) => String(reference).trim()));
	return repair_nodes((reference) => missing.has(reference));
}

/** Node ids in run errors can name a node inside a subgraph instance. */
function find_node_by_execution_id(execution_id)
{
	if (execution_id == null || !execution_id)
	{
		return null;
	}

	const direct = app?.graph?.getNodeById?.(execution_id);
	if (direct)
	{
		return direct;
	}

	let graph = app?.rootGraph ?? app?.graph;
	let node = null;
	for (const segment of String(execution_id).split(":"))
	{
		node = graph?.getNodeById?.(segment) ?? null;
		if (!node)
		{
			return null;
		}
		graph = node.subgraph ?? graph;
	}
	return node;
}

function repair_execution_error(error)
{
	const node_type = error?.node_type ?? error?.nodeType;
	const message = `${error?.exception_message ?? ""} ${error?.exception_type ?? ""}`;
	if (!REPAIRABLE_NODE_INPUTS.has(node_type) || !MISSING_FILE_PATTERN.test(message))
	{
		return;
	}

	const node = find_node_by_execution_id(error?.node_id ?? error?.nodeId);
	if (node && apply_placeholder_image(node))
	{
		schedule_protected_files_sync();
	}
}

/** Ask the server which of the graph's image references no longer exist. */
async function repair_missing_files_now()
{
	if (!repair_missing_files)
	{
		return 0;
	}

	const file_references = new Set();
	collect_live_graph_protected_files(app?.rootGraph ?? app?.graph, file_references, new Set(REPAIRABLE_NODE_INPUTS.keys()));
	if (file_references.size === 0)
	{
		return 0;
	}

	try
	{
		const response = await fetch(MISSING_FILES_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ files: [...file_references] })
		});
		const payload = await response.json();
		return repair_missing_file_references(payload?.missing);
	}
	catch (error)
	{
		console.error("Error checking for cleaned files:", error);
		return 0;
	}
}

/** A Pinia store by id, for the hooks that must observe the editor's own state. */
function get_pinia_store(store_id)
{
	try
	{
		const pinia = document.getElementById("vue-app")?.__vue_app__?.config?.globalProperties?.$pinia;
		return pinia?._s?.get(store_id) ?? null;
	}
	catch (error)
	{
		return null;
	}
}

function get_missing_media_store()
{
	return get_pinia_store(MISSING_MEDIA_STORE_ID);
}

/**
 * A node whose image file is gone fails the backend's validation with
 * `custom_validation_failed` / "Invalid image file", which is what the editor
 * renders as "Input image couldn't be loaded". The editor only refills a
 * widget's option list when it lists the files again, so a file that was
 * listed and then deleted keeps passing the local checks - this is the report
 * that catches it.
 */
function get_image_not_loaded_nodes(node_errors)
{
	const nodes = [];
	for (const [node_id, entry] of Object.entries(node_errors ?? {}))
	{
		const errors = Array.isArray(entry?.errors) ? entry.errors : [];
		// Validation only: an execution error that mentions an image arrives on
		// its own path, and a run that already started must not be re-submitted.
		const is_image_error = errors.some((error) =>
			error?.type === "custom_validation_failed" &&
			MISSING_FILE_PATTERN.test(`${error?.message ?? ""} ${error?.details ?? ""}`));
		if (!is_image_error)
		{
			continue;
		}

		const node = find_node_by_execution_id(error_node_id(entry, node_id))
			?? find_node_by_execution_id(node_id);
		if (node && get_repairable_widget(node))
		{
			nodes.push(node);
		}
	}
	return nodes;
}

/** Validation reports key by node id, or carry it in extra_info. */
function error_node_id(entry, fallback)
{
	for (const error of entry?.errors ?? [])
	{
		const candidate = error?.extra_info?.node_id ?? error?.extra_info?.nodeId;
		if (candidate != null && candidate !== "")
		{
			return candidate;
		}
	}
	return fallback;
}

/**
 * Repair the nodes a failed validation blamed, and count them so the queue
 * wrapper knows the failure was ours to fix rather than a reason to stop.
 */
function repair_validation_errors(node_errors)
{
	let repaired = 0;
	for (const node of get_image_not_loaded_nodes(node_errors))
	{
		if (apply_placeholder_image(node))
		{
			repaired += 1;
		}
	}

	repairs_during_queue += repaired;
	return repaired;
}

function install_validation_error_hook()
{
	const store = get_pinia_store(EXECUTION_ERROR_STORE_ID);
	if (!store || typeof store.recordNodeErrors !== "function")
	{
		return false;
	}

	if (!store.__temp_file_cleaner_hooked)
	{
		const original = store.recordNodeErrors;
		store.recordNodeErrors = function (node_errors, key)
		{
			const result = original.apply(this, arguments);
			try
			{
				repair_validation_errors(node_errors);
			}
			catch (error)
			{
				console.error("Temp File Cleaner could not repair a rejected image:", error);
			}

			return result;
		};
		store.__temp_file_cleaner_hooked = true;
	}

	return true;
}

/**
 * The frontend already scans media widgets, verifies them against the asset
 * list, and reports the ones that are gone. Repair those rows too, so a load
 * with a cleaned file resolves the missing-media warning instead of merely
 * surviving the next run.
 */
function repair_missing_media(media)
{
	if (!repair_missing_files)
	{
		return 0;
	}

	if (!Array.isArray(media) || media.length === 0)
	{
		return 0;
	}

	const store = get_missing_media_store();
	const repaired = [];
	for (const candidate of media)
	{
		if (candidate?.isMissing === false)
		{
			continue;
		}

		if (!REPAIRABLE_NODE_INPUTS.has(candidate?.nodeType) && candidate?.widgetName !== "image")
		{
			continue;
		}

		const node = find_node_by_execution_id(candidate?.nodeId);
		const widget = node?.widgets?.find((entry) => entry.name === candidate?.widgetName)
			?? get_repairable_widget(node);
		const reference = String(candidate?.name ?? "").trim();
		if (!node || !widget || !reference || String(widget.value ?? "").trim() !== reference)
		{
			continue;
		}

		if (apply_placeholder_image(node))
		{
			repaired.push(candidate);
		}
	}

	for (const candidate of repaired)
	{
		// The warning describes a value that is no longer there, so drop it.
		store?.removeMissingMediaByWidget?.(String(candidate.nodeId), candidate.widgetName);
	}

	return repaired.length;
}

function install_missing_media_hook()
{
	const store = get_missing_media_store();
	if (!store)
	{
		return false;
	}

	if (!store.__temp_file_cleaner_hooked)
	{
		if (typeof store.setMissingMedia !== "function")
		{
			return false;
		}

		const original = store.setMissingMedia;
		store.setMissingMedia = function (media)
		{
			const result = original.apply(this, arguments);
			try
			{
				repair_missing_media(media);
			}
			catch (error)
			{
				console.error("Temp File Cleaner could not repair missing media:", error);
			}

			return result;
		};
		store.__temp_file_cleaner_hooked = true;
	}

	// The pipeline may have published its list before this extension loaded.
	repair_missing_media(store.missingMediaCandidates);
	return true;
}

let store_hook_attempts = 0;

/** Both stores are created lazily, possibly after this extension loads. */
function schedule_store_hook_install(attempts = 20)
{
	const installed = install_missing_media_hook() & install_validation_error_hook();
	if (installed || store_hook_attempts >= attempts)
	{
		return;
	}

	store_hook_attempts += 1;
	setTimeout(() => schedule_store_hook_install(attempts), 500);
}

function install_run_hooks()
{
	api.addEventListener("execution_error", (event) => repair_execution_error(event?.detail ?? event));

	const original_queue_prompt = app.queuePrompt;
	if (typeof original_queue_prompt !== "function" || original_queue_prompt.__temp_file_cleaner_wrapper)
	{
		return;
	}

	const wrapped_queue_prompt = async function()
	{
		try
		{
			await repair_missing_files_now();
		}
		catch (error)
		{
			console.error("Temp File Cleaner repair failed:", error);
		}

		repairs_during_queue = 0;
		const result = await original_queue_prompt.apply(this, arguments);

		// The prompt was rejected because one of its images is gone; the repair
		// above has already pointed that node at the placeholder, so the run the
		// user asked for can go through.
		if (repairs_during_queue > 0)
		{
			repairs_during_queue = 0;
			return original_queue_prompt.apply(this, arguments);
		}

		return result;
	};

	wrapped_queue_prompt.__temp_file_cleaner_wrapper = true;
	wrapped_queue_prompt.__temp_file_cleaner_original = original_queue_prompt;
	app.queuePrompt = wrapped_queue_prompt;
}

app.registerExtension({
	name: EXTENSION_NAME,

	nodeCreated(node)
	{
		watch_protected_node(node);
	},

	afterConfigureGraph()
	{
		schedule_protected_files_sync(0);
		schedule_store_hook_install();
	},

	async setup()
	{
		install_run_hooks();
		schedule_store_hook_install();

		let settings = await fetch_server_settings();
		set_active_file_protection(settings.protect_active_files);
		set_file_repair(settings.repair_missing_files);
		start_active_file_protection();

		const ui_settings = app?.ui?.settings;
		if (!ui_settings)
		{
			return;
		}

		if (ui_settings.setup)
		{
			await ui_settings.setup;
		}

		if (ui_settings[SETTINGS_INSTALL_FLAG])
		{
			return;
		}

		const settings_access = get_settings_access();
		if (!settings_access?.add_setting)
		{
			return;
		}

		ui_settings[SETTINGS_INSTALL_FLAG] = true;

		settings_access.add_setting({
			id: SETTING_IDS.age_limit,
			category: build_setting_category("Age limit"),
			name: "Delete files older than this many minutes",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: settings.age_limit,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					age_limit: normalize_integer(new_value, settings.age_limit, 0)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.check_frequency,
			category: build_setting_category("Check frequency"),
			name: "Cleanup check frequency in minutes",
			type: "number",
			attrs: { min: 1, step: 1 },
			defaultValue: settings.check_frequency,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					check_frequency: normalize_integer(new_value, settings.check_frequency, 1)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.max_files,
			category: build_setting_category("Max files"),
			name: "Max files per cleaned folder (delete oldest when exceeded)",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: settings.max_files,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					max_files: normalize_integer(new_value, settings.max_files, 0)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.enable_logging,
			category: build_setting_category("Logging"),
			name: "Print log messages",
			type: "boolean",
			defaultValue: settings.enable_logging,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					enable_logging: normalize_boolean(new_value, settings.enable_logging)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.protect_active_files,
			category: build_setting_category("Active files"),
			name: "Protect active files",
			type: "boolean",
			defaultValue: settings.protect_active_files,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					protect_active_files: normalize_boolean(new_value, settings.protect_active_files)
				});
				set_active_file_protection(settings.protect_active_files);
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.repair_missing_files,
			category: build_setting_category("Missing files"),
			name: "Point nodes at the placeholder when their image file is gone",
			type: "boolean",
			defaultValue: settings.repair_missing_files,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					repair_missing_files: normalize_boolean(new_value, settings.repair_missing_files)
				});
				set_file_repair(settings.repair_missing_files);
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.trash_destination,
			category: build_setting_category("Trash destination"),
			name: "Trash destination (leave empty to permanently delete)",
			type: "string",
			defaultValue: settings.trash_destination,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					trash_destination: normalize_string(new_value, settings.trash_destination)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.cleaning_paths,
			category: build_setting_category("Folders"),
			name: "Relative folders to clean (comma-delimited)",
			type: "string",
			attrs: { placeholder: "temp,input,input/pasted" },
			defaultValue: settings.cleaning_paths,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					cleaning_paths: normalize_cleaning_paths(new_value)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.whitelist,
			category: build_setting_category("Whitelist"),
			name: "Only clean these filenames (comma-delimited; leave empty for all)",
			type: "string",
			attrs: { placeholder: "render.png,preview.webp" },
			defaultValue: settings.whitelist,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					whitelist: normalize_file_name_list(new_value)
				});
			}
		});

		settings_access.add_setting({
			id: SETTING_IDS.blacklist,
			category: build_setting_category("Blacklist"),
			name: "Never clean these filenames (comma-delimited)",
			type: "string",
			attrs: { placeholder: DEFAULT_SETTINGS.blacklist },
			defaultValue: settings.blacklist,
			onChange: async (new_value) =>
			{
				settings = await save_server_settings({
					...settings,
					blacklist: normalize_file_name_list(new_value)
				});
			}
		});

		const ui_settings_values = read_ui_settings(settings_access, settings);
		if (JSON.stringify(ui_settings_values) !== JSON.stringify(settings))
		{
			settings = await save_server_settings(ui_settings_values);
			set_active_file_protection(settings.protect_active_files);
			set_file_repair(settings.repair_missing_files);
		}
	}
});
