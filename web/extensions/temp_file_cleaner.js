import { app } from "/scripts/app.js";

const EXTENSION_NAME = "comfy.temp_file_cleaner";
const SETTINGS_ENDPOINT = "/temp_file_cleaner/settings";
const SETTINGS_PANEL_LABEL = "Temp File Cleaner";
const SETTINGS_SECTION_LABEL = "General";
const SETTINGS_INSTALL_FLAG = "__temp_file_cleaner_settings_installed";

const SETTING_IDS = {
	age_limit: "temp_file_cleaner.age_limit",
	check_frequency: "temp_file_cleaner.check_frequency",
	max_files: "temp_file_cleaner.max_files",
	enable_logging: "temp_file_cleaner.enable_logging",
	trash_destination: "temp_file_cleaner.trash_destination",
	cleaning_paths: "temp_file_cleaner.cleaning_paths"
};

const DEFAULT_SETTINGS = {
	age_limit: 120,
	check_frequency: 10,
	max_files: 100,
	enable_logging: true,
	trash_destination: "",
	cleaning_paths: "temp"
};

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

function normalize_settings(raw_settings)
{
	return {
		age_limit: normalize_integer(raw_settings?.age_limit, DEFAULT_SETTINGS.age_limit, 0),
		check_frequency: normalize_integer(raw_settings?.check_frequency, DEFAULT_SETTINGS.check_frequency, 1),
		max_files: normalize_integer(raw_settings?.max_files, DEFAULT_SETTINGS.max_files, 0),
		enable_logging: normalize_boolean(raw_settings?.enable_logging, DEFAULT_SETTINGS.enable_logging),
		trash_destination: normalize_string(raw_settings?.trash_destination, DEFAULT_SETTINGS.trash_destination),
		cleaning_paths: normalize_cleaning_paths(raw_settings?.cleaning_paths)
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
		trash_destination: settings_access.get(SETTING_IDS.trash_destination, fallback_settings.trash_destination),
		cleaning_paths: settings_access.get(SETTING_IDS.cleaning_paths, fallback_settings.cleaning_paths)
	});
}

app.registerExtension({
	name: EXTENSION_NAME,

	async setup()
	{
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

		let settings = await fetch_server_settings();

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

		const ui_settings_values = read_ui_settings(settings_access, settings);
		if (JSON.stringify(ui_settings_values) !== JSON.stringify(settings))
		{
			settings = await save_server_settings(ui_settings_values);
		}
	}
});
