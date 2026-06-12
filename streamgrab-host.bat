@echo off
rem Launcher Chrome invokes as the native messaging host. Runs the Node host,
rem inheriting stdin/stdout so the binary message framing passes through.
rem Requires Node.js on PATH.
node "%~dp0src\native-host\host.js"
