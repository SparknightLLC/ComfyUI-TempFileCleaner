import { app } from "../../../scripts/app.js";

app.registerExtension({
	name: "comfy.temp_file_cleaner",
	settings: [
		{
			id: "temp_file_cleaner.age_limit",
			name: "Delete temp files older than this many minutes",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: 30,
			onChange: async (newVal) =>
			{
				const current = await (await fetch("/temp_file_cleaner/settings")).json();
				current.age_limit = newVal;
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(current)
				});
			}
		},
		{
			id: "temp_file_cleaner.check_frequency",
			name: "Cleanup check frequency in minutes",
			type: "number",
			attrs: { min: 1, step: 1 },
			defaultValue: 5,
			onChange: async (newVal) =>
			{
				const current = await (await fetch("/temp_file_cleaner/settings")).json();
				current.check_frequency = newVal;
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(current)
				});
			}
		},
		{
			id: "temp_file_cleaner.max_files",
			name: "Max files in temp folder (delete oldest when exceeded)",
			type: "number",
			attrs: { min: 0, step: 1 },
			defaultValue: 100,
			onChange: async (newVal) =>
			{
				const current = await (await fetch("/temp_file_cleaner/settings")).json();
				current.max_files = newVal;
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(current)
				});
			}
		},
		{
			id: "temp_file_cleaner.enable_logging",
			name: "Print log messages",
			type: "boolean",
			defaultValue: true,
			onChange: async (newVal) =>
			{
				const current = await (await fetch("/temp_file_cleaner/settings")).json();
				current.enable_logging = newVal;
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(current)
				});
			}
		},
		{
			id: "temp_file_cleaner.trash_destination",
			name: "Trash destination (leave empty to permanently delete)",
			type: "string",
			defaultValue: "",
			onChange: async (newVal) =>
			{
				const current = await (await fetch("/temp_file_cleaner/settings")).json();
				current.trash_destination = newVal;
				await fetch("/temp_file_cleaner/settings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(current)
				});
			}
		}
	],
	async setup()
	{
		let settings;
		try
		{
			const response = await fetch("/temp_file_cleaner/settings");
			settings = await response.json();
		} catch (error)
		{
			console.error("Error fetching temp_file_cleaner settings:", error);
			settings = {
				age_limit: 30,
				check_frequency: 300,
				max_files: 100,
				enable_logging: true,
				trash_destination: ""
			};
		}

		app.extensionManager.setting.set("temp_file_cleaner.age_limit", settings.age_limit);
		app.extensionManager.setting.set("temp_file_cleaner.check_frequency", settings.check_frequency);
		app.extensionManager.setting.set("temp_file_cleaner.max_files", settings.max_files);
		app.extensionManager.setting.set("temp_file_cleaner.enable_logging", settings.enable_logging);
		app.extensionManager.setting.set("temp_file_cleaner.trash_destination", settings.trash_destination);
	}
});