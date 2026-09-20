# ComfyUI-TempFileCleaner

<img width="600" alt="image" src="https://github.com/user-attachments/assets/4a34af5f-ca63-4998-9965-94908d4b37de" />

An extension for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that deletes or moves files out of one or more relative folders such as `temp` or `input/pasted` to improve performance. Highly customizable.

Comfy automatically deletes the contents of your `temp` folder on startup, but if you amass a lot of files over the course of a session, it can degrade performance - particularly if any extensions, firewall software, etc. attempt to check the `temp` folder.

---

### Repaired files

Protection covers the files a workflow currently references, but a file can still be cleaned - the folder may be emptied by ComfyUI itself, the file may be removed by hand, or the node may be edited while a long queue runs. Rather than failing the run, the cleaner repairs the node: `Load Image`, `Load Image (as Mask)`, `Load Image (from Outputs)`, and `Preview Image` are pointed at `input/temp_file_cleaner_placeholder.png`, a 16x16 gray PNG the cleaner writes on startup and never cleans. A warning names the node and the file it replaced, so the source can be protected or re-uploaded before the next run.

Repair happens four times over, cheapest first:

- **When the frontend reports missing media.** The editor already scans media widgets after a
  load and flags the values that no longer resolve, which is what produces the "missing a
  required media file" warning. The cleaner repairs those rows as that list is published and
  clears the stale warning. This costs nothing extra: it reuses the frontend's own scan.
- **Before every queued prompt.** One request (a couple of milliseconds on a local server)
  asks which of the graph's image references are gone, so a file cleaned mid-session is caught
  before it can fail a run.
- **When the backend rejects the prompt.** A file that is listed in a widget's dropdown and then
  deleted keeps passing the local checks until the list is refreshed again, so the request comes
  back as `custom_validation_failed` / "Invalid image file" (the editor shows "Input image
  couldn't be loaded"). The cleaner repairs the blamed node and re-submits the prompt once, so
  the run the user asked for still happens.
- **After a run reports a missing image**, for a file that vanished between the check and the
  node reading it.

All four are controlled by `repair_missing_files`, which defaults to `true`. With it off, cleaned
files are left alone: the run fails the way it would without this extension, and nothing is
rewritten.

---

### age_limit (int)

Any files older than this many minutes will be removed during the cleanup routine. Default: `120`. Set to `0` to disable age-based cleanup.

### check_frequency (int)

How often to run the cleanup routine, in minutes.

### cleaning_paths (string)

Comma-delimited list of relative folders to clean. Note that it will **not** traverse the subfolders of each entry. Default: `temp`.

Examples:

- `temp`
- `temp,input,input/pasted`

### whitelist (string)

Comma-delimited list of filenames to clean. Leave empty to allow every filename. If a whitelist is set, files not listed here will be ignored. Default: empty.

### blacklist (string)

Comma-delimited list of filenames that should never be cleaned. Blacklist entries take priority over whitelist entries. Default: `bedroom.mp4,example_image.jpg,groceries.jpg,image.png`.

### protect_active_files (bool)

Protect files selected in `Load Image`, `Load Image (as Mask)`, and `Load Image (from Outputs)` nodes belonging to open workflows. Files referenced by queued or running prompts are also protected. Default: `true`.

### repair_missing_files (bool)

Point a node whose image file is gone at `input/temp_file_cleaner_placeholder.png` instead of letting the run fail, and warn about the file that was replaced. Covers `Load Image`, `Load Image (as Mask)`, `Load Image (from Outputs)`, and `Preview Image`. Default: `true`.

### enable_logging (bool)

Print messages to the console for debugging purposes.

### max_files (int)

Maximum number of files allowed in each cleaned folder. Deletes the oldest files in excess of this value. Set to `0` to disable quantity-based cleanup.

### trash_destination (string)

If specified, the cleanup routine will move files to this path instead of deleting them.
