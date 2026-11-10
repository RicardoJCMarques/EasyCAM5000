# Security Notice & Third-Party Files

This project is a 100% client-side web application. It runs entirely inside your browser and has no backend or server-side data processing.

### Responsibility for Code vs. Configuration
- **Our responsibility:** We maintain and verify only the source code and assets hosted directly within this repository.
- **Your responsibility:** If you use third-party files - language packs or other `.json` kind files - with the app, you are responsible for inspecting their contents first. 

### Third-Party Files Warning
Don't use `.json` files from untrusted and unverified sources.
Even though kind files are barebones data, untrusted files could attempt to alter the app's behavior or inject/run unwanted code through unpatched flaws in your browser.

Always:
1. Verify who provided the file before loading it.
2. Inspect the file in a text editor if you are unsure of its contents.
3. Ensure you are using an up-to-date, modern browser with current security protections.