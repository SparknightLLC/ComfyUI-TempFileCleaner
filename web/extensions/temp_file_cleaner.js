import { app } from "../../../scripts/app.js";

app.registerExtension({
	name: "comfy.temp_file_cleaner",
	async setup()
	{
		if (app?.ui?.settings?.setup)
		{
			await app.ui.settings.setup;
		}

		const default_settings = {
			age_limit: 30,
			check_frequency: 5,
			max_files: 100,
			enable_logging: true,
			trash_destination: ""
		};

		const normalize_number = (value, fallback) =>
		{
			if (typeof value !== "number" || Number.isNaN(value))
			{
				return fallback;
			}

			return value;
		};

		let settings = default_settings;
		try
		{
			const response = await fetch("/temp_file_cleaner/settings");
			if (response.ok)
			{
				const data = await response.json();
				settings = {
					age_limit: normalize_number(data?.age_limit, default_settings.age_limit),
					check_frequency: normalize_number(data?.check_frequency, default_settings.check_frequency),
					max_files: normalize_number(data?.max_files, default_settings.max_files),
					enable_logging: typeof data?.enable_logging === "boolean" ? data.enable_logging : default_settings.enable_logging,
					trash_destination: typeof data?.trash_destination === "string" ? data.trash_destination : default_settings.trash_destination
				};
			}
		} catch (error)
		{
			console.error("Error fetching temp_file_cleaner settings:", error);
		}

		const save_settings = async (updates) =>
		{
			settings = {
				...settings,
				...updates
			};

			try
			{
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(settings)
				});
			} catch (error)
			{
				console.error("Error updating temp_file_cleaner settings:", error);
			}
		};

		app.ui.settings.addSetting({
			id: "temp_file_cleaner.age_limit",
			name: "Delete temp files older than this many minutes",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: settings.age_limit,
			onChange: async (new_value) =>
			{
				await save_settings({ age_limit: new_value });
			}
		});

		app.ui.settings.addSetting({
			id: "temp_file_cleaner.check_frequency",
			name: "Cleanup check frequency in minutes",
			type: "number",
			attrs: { min: 1, step: 1 },
			defaultValue: settings.check_frequency,
			onChange: async (new_value) =>
			{
				await save_settings({ check_frequency: new_value });
			}
		});

		app.ui.settings.addSetting({
			id: "temp_file_cleaner.max_files",
			name: "Max files in temp folder (delete oldest when exceeded)",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: settings.max_files,
			onChange: async (new_value) =>
			{
				await save_settings({ max_files: new_value });
			}
		});

		app.ui.settings.addSetting({
			id: "temp_file_cleaner.enable_logging",
			name: "Print log messages",
			type: "boolean",
			defaultValue: settings.enable_logging,
			onChange: async (new_value) =>
			{
				await save_settings({ enable_logging: new_value });
			}
		});

		app.ui.settings.addSetting({
			id: "temp_file_cleaner.trash_destination",
			name: "Trash destination (leave empty to permanently delete)",
			type: "string",
			defaultValue: settings.trash_destination,
			onChange: async (new_value) =>
			{
				await save_settings({ trash_destination: new_value });
			}
		});
	}
});
