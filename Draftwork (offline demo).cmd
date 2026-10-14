@echo off
rem Offline demo: timestamps come from the built-in demo TSA (marked "not trusted" in the viewer),
rem and a demo class is generated for "Load the demo class" on the instructor page.
call "%~dp0Draftwork.cmd" --mock-tsa --demo --page instructor %*
