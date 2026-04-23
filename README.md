# ComfyUI-TempFileCleaner

<img width="600" alt="image" src="https://github.com/user-attachments/assets/4a34af5f-ca63-4998-9965-94908d4b37de" />

An extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that deletes or moves files out of one or more relative folders such as `temp` or `input/pasted` to improve performance. Highly customizable.

Comfy automatically deletes the contents of your `temp` folder on startup, but if you amass a lot of files over the course of a session, it can degrade performance - particularly if any extensions, firewall software, etc. attempt to check the `temp` folder.

---

### age_limit (int)

Any files older than this many minutes will be removed during the cleanup routine. Default: `120`. Set to `0` to disable age-based cleanup.

### check_frequency (int)

How often to run the cleanup routine, in minutes.

### cleaning_paths (string)

Comma-delimited list of relative folders to clean. Default: `temp`.

Examples:

- `temp`
- `temp,input,input/pasted`

### enable_logging (bool)

Print messages to the console for debugging purposes.

### max_files (int)

Maximum number of files allowed in each cleaned folder. Deletes the oldest files in excess of this value. Set to `0` to disable quantity-based cleanup.

### trash_destination (string)

If specified, the cleanup routine will move files to this path instead of deleting them.
