#!/usr/bin/env python3
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "RubatoChatDemo.xcodeproj"
PBXPROJ = PROJECT / "project.pbxproj"
CHAT_LAYOUT_REVISION = "cf01193e9d20d448d0005f563063924c667e4496"


def oid(label: str) -> str:
    return hashlib.sha1(label.encode()).hexdigest().upper()[:24]


def q(value: str) -> str:
    if all(ch.isalnum() or ch in "_.$()/" for ch in value):
        return value
    return f'"{value}"'


source_files = sorted((ROOT / "Sources").rglob("*.swift"))
test_files = sorted((ROOT / "Tests").rglob("*.swift"))
all_files = source_files + test_files

objects: list[str] = []

# IDs
project_id = oid("project")
main_group_id = oid("main-group")
products_group_id = oid("products-group")
frameworks_group_id = oid("frameworks-group")
sources_group_id = oid("sources-group")
tests_group_id = oid("tests-group")
app_target_id = oid("app-target")
test_target_id = oid("test-target")
app_product_id = oid("app-product")
test_product_id = oid("test-product")
app_sources_phase_id = oid("app-sources-phase")
test_sources_phase_id = oid("test-sources-phase")
app_frameworks_phase_id = oid("app-frameworks-phase")
test_frameworks_phase_id = oid("test-frameworks-phase")
app_resources_phase_id = oid("app-resources-phase")
test_resources_phase_id = oid("test-resources-phase")
package_ref_id = oid("chatlayout-package")
package_product_id = oid("chatlayout-product")
package_build_id = oid("chatlayout-build")
xctest_ref_id = oid("xctest-framework-ref")
xctest_build_id = oid("xctest-framework-build")
container_proxy_id = oid("test-container-proxy")
target_dependency_id = oid("test-target-dependency")
project_config_list_id = oid("project-config-list")
app_config_list_id = oid("app-config-list")
test_config_list_id = oid("test-config-list")

file_ref_ids = {path: oid(f"file:{path.relative_to(ROOT)}") for path in all_files}
build_file_ids = {path: oid(f"build:{path.relative_to(ROOT)}") for path in all_files}

# PBXBuildFile
for path in source_files:
    objects.append(f"\t\t{build_file_ids[path]} /* {path.name} in Sources */ = {{isa = PBXBuildFile; fileRef = {file_ref_ids[path]} /* {path.name} */; }};")
for path in test_files:
    objects.append(f"\t\t{build_file_ids[path]} /* {path.name} in Sources */ = {{isa = PBXBuildFile; fileRef = {file_ref_ids[path]} /* {path.name} */; }};")
objects.append(f"\t\t{package_build_id} /* ChatLayout in Frameworks */ = {{isa = PBXBuildFile; productRef = {package_product_id} /* ChatLayout */; }};")
objects.append(f"\t\t{xctest_build_id} /* XCTest.framework in Frameworks */ = {{isa = PBXBuildFile; fileRef = {xctest_ref_id} /* XCTest.framework */; }};")

# Proxy/dependency
objects.append(f'''\t\t{container_proxy_id} /* PBXContainerItemProxy */ = {{
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = {project_id} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = {app_target_id};
\t\t\tremoteInfo = RubatoChatDemo;
\t\t}};''')

# File references
objects.append(f"\t\t{app_product_id} /* RubatoChatDemo.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = RubatoChatDemo.app; sourceTree = BUILT_PRODUCTS_DIR; }};")
objects.append(f"\t\t{test_product_id} /* RubatoChatDemoTests.xctest */ = {{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = RubatoChatDemoTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }};")
objects.append(f"\t\t{xctest_ref_id} /* XCTest.framework */ = {{isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = XCTest.framework; path = System/Library/Frameworks/XCTest.framework; sourceTree = SDKROOT; }};")
for path in all_files:
    objects.append(f"\t\t{file_ref_ids[path]} /* {path.name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {q(path.name)}; sourceTree = \"<group>\"; }};")

# Framework phases
objects.append(f'''\t\t{app_frameworks_phase_id} /* Frameworks */ = {{
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t{package_build_id} /* ChatLayout in Frameworks */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};''')
objects.append(f'''\t\t{test_frameworks_phase_id} /* Frameworks */ = {{
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t{xctest_build_id} /* XCTest.framework in Frameworks */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};''')

# Groups recursively

def group_for(directory: Path, label: str) -> str:
    group_id = oid(f"group:{directory.relative_to(ROOT) if directory != ROOT else 'root'}")
    child_dirs = sorted([p for p in directory.iterdir() if p.is_dir() and any(p.rglob("*.swift"))], key=lambda p: p.name)
    child_files = sorted([p for p in directory.iterdir() if p.suffix == ".swift"], key=lambda p: p.name)
    child_entries = []
    for child in child_dirs:
        child_id = group_for(child, child.name)
        child_entries.append(f"\t\t\t\t{child_id} /* {child.name} */,")
    for child in child_files:
        child_entries.append(f"\t\t\t\t{file_ref_ids[child]} /* {child.name} */,")
    path_line = "" if directory == ROOT else f"\n\t\t\tpath = {q(label)};"
    objects.append(f'''\t\t{group_id} /* {label} */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{chr(10).join(child_entries)}
\t\t\t);{path_line}
\t\t\tsourceTree = "<group>";
\t\t}};''')
    return group_id

# Override deterministic IDs for top-level source/test groups by creating contents manually.
def build_top_group(directory: Path, group_id: str, label: str) -> None:
    child_entries = []
    for child in sorted([p for p in directory.iterdir() if p.is_dir()], key=lambda p: p.name):
        if any(child.rglob("*.swift")):
            child_id = group_for(child, child.name)
            child_entries.append(f"\t\t\t\t{child_id} /* {child.name} */,")
    for child in sorted([p for p in directory.iterdir() if p.suffix == ".swift"], key=lambda p: p.name):
        child_entries.append(f"\t\t\t\t{file_ref_ids[child]} /* {child.name} */,")
    objects.append(f'''\t\t{group_id} /* {label} */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{chr(10).join(child_entries)}
\t\t\t);
\t\t\tpath = {label};
\t\t\tsourceTree = "<group>";
\t\t}};''')

build_top_group(ROOT / "Sources", sources_group_id, "Sources")
build_top_group(ROOT / "Tests", tests_group_id, "Tests")
objects.append(f'''\t\t{products_group_id} /* Products */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{app_product_id} /* RubatoChatDemo.app */,
\t\t\t\t{test_product_id} /* RubatoChatDemoTests.xctest */,
\t\t\t);
\t\t\tname = Products;
\t\t\tsourceTree = "<group>";
\t\t}};''')
objects.append(f'''\t\t{frameworks_group_id} /* Frameworks */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{xctest_ref_id} /* XCTest.framework */,
\t\t\t);
\t\t\tname = Frameworks;
\t\t\tsourceTree = "<group>";
\t\t}};''')
objects.append(f'''\t\t{main_group_id} = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{sources_group_id} /* Sources */,
\t\t\t\t{tests_group_id} /* Tests */,
\t\t\t\t{products_group_id} /* Products */,
\t\t\t\t{frameworks_group_id} /* Frameworks */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t}};''')

# Native targets
objects.append(f'''\t\t{app_target_id} /* RubatoChatDemo */ = {{
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = {app_config_list_id} /* Build configuration list for PBXNativeTarget "RubatoChatDemo" */;
\t\t\tbuildPhases = (
\t\t\t\t{app_sources_phase_id} /* Sources */,
\t\t\t\t{app_frameworks_phase_id} /* Frameworks */,
\t\t\t\t{app_resources_phase_id} /* Resources */,
\t\t\t);
\t\t\tbuildRules = ();
\t\t\tdependencies = ();
\t\t\tname = RubatoChatDemo;
\t\t\tpackageProductDependencies = (
\t\t\t\t{package_product_id} /* ChatLayout */,
\t\t\t);
\t\t\tproductName = RubatoChatDemo;
\t\t\tproductReference = {app_product_id} /* RubatoChatDemo.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t}};''')
objects.append(f'''\t\t{test_target_id} /* RubatoChatDemoTests */ = {{
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = {test_config_list_id} /* Build configuration list for PBXNativeTarget "RubatoChatDemoTests" */;
\t\t\tbuildPhases = (
\t\t\t\t{test_sources_phase_id} /* Sources */,
\t\t\t\t{test_frameworks_phase_id} /* Frameworks */,
\t\t\t\t{test_resources_phase_id} /* Resources */,
\t\t\t);
\t\t\tbuildRules = ();
\t\t\tdependencies = (
\t\t\t\t{target_dependency_id} /* PBXTargetDependency */,
\t\t\t);
\t\t\tname = RubatoChatDemoTests;
\t\t\tproductName = RubatoChatDemoTests;
\t\t\tproductReference = {test_product_id} /* RubatoChatDemoTests.xctest */;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t}};''')

# Project
objects.append(f'''\t\t{project_id} /* Project object */ = {{
\t\t\tisa = PBXProject;
\t\t\tattributes = {{
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 2600;
\t\t\t\tLastUpgradeCheck = 2600;
\t\t\t\tTargetAttributes = {{
\t\t\t\t\t{app_target_id} = {{ CreatedOnToolsVersion = 26.0; }};
\t\t\t\t\t{test_target_id} = {{ CreatedOnToolsVersion = 26.0; TestTargetID = {app_target_id}; }};
\t\t\t\t}};
\t\t\t}};
\t\t\tbuildConfigurationList = {project_config_list_id} /* Build configuration list for PBXProject "RubatoChatDemo" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = ko;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (ko, en, Base);
\t\t\tmainGroup = {main_group_id};
\t\t\tpackageReferences = (
\t\t\t\t{package_ref_id} /* XCRemoteSwiftPackageReference "ChatLayout" */,
\t\t\t);
\t\t\tproductRefGroup = {products_group_id} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t{app_target_id} /* RubatoChatDemo */,
\t\t\t\t{test_target_id} /* RubatoChatDemoTests */,
\t\t\t);
\t\t}};''')

# Empty resources phases
for phase_id, name in [(app_resources_phase_id, "Resources"), (test_resources_phase_id, "Resources")]:
    objects.append(f'''\t\t{phase_id} /* {name} */ = {{
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = ();
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};''')

# Sources phases
objects.append(f'''\t\t{app_sources_phase_id} /* Sources */ = {{
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
{chr(10).join(f'\t\t\t\t{build_file_ids[p]} /* {p.name} in Sources */,' for p in source_files)}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};''')
objects.append(f'''\t\t{test_sources_phase_id} /* Sources */ = {{
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
{chr(10).join(f'\t\t\t\t{build_file_ids[p]} /* {p.name} in Sources */,' for p in test_files)}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};''')

# Dependency
objects.append(f'''\t\t{target_dependency_id} /* PBXTargetDependency */ = {{
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = {app_target_id} /* RubatoChatDemo */;
\t\t\ttargetProxy = {container_proxy_id} /* PBXContainerItemProxy */;
\t\t}};''')

# Build configurations
project_debug = oid("project-debug")
project_release = oid("project-release")
app_debug = oid("app-debug")
app_release = oid("app-release")
test_debug = oid("test-debug")
test_release = oid("test-release")

objects.append(f'''\t\t{project_debug} /* Debug */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tDEBUG_INFORMATION_FORMAT = dwarf;
\t\t\t\tENABLE_TESTABILITY = YES;
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t}};
\t\t\tname = Debug;
\t\t}};''')
objects.append(f'''\t\t{project_release} /* Release */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;
\t\t\t\tCLANG_ENABLE_MODULES = YES;
\t\t\t\tDEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
\t\t\t\tGCC_C_LANGUAGE_STANDARD = gnu17;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_COMPILATION_MODE = wholemodule;
\t\t\t}};
\t\t\tname = Release;
\t\t}};''')


def app_settings(config_id: str, name: str) -> str:
    return f'''\t\t{config_id} /* {name} */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_ASSET_PATHS = "";
\t\t\t\tENABLE_PREVIEWS = YES;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "Rubato Chat";
\t\t\t\tINFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.developer-tools";
\t\t\t\tINFOPLIST_KEY_NSMicrophoneUsageDescription = "음성 메시지를 녹음하려면 마이크 접근이 필요해요.";
\t\t\t\tINFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
\t\t\t\tINFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
\t\t\t\tINFOPLIST_KEY_UILaunchScreen_Generation = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks");
\t\t\t\tMARKETING_VERSION = 0.1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.rubato.chatdemo;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
\t\t\t\tSUPPORTS_MACCATALYST = NO;
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tSWIFT_STRICT_CONCURRENCY = complete;
\t\t\t\tSWIFT_VERSION = 6.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t}};
\t\t\tname = {name};
\t\t}};'''

objects.append(app_settings(app_debug, "Debug"))
objects.append(app_settings(app_release, "Release"))


def test_settings(config_id: str, name: str) -> str:
    return f'''\t\t{config_id} /* {name} */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tBUNDLE_LOADER = "$(TEST_HOST)";
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tGENERATE_INFOPLIST_FILE = YES;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 26.0;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks");
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.rubato.chatdemo.tests;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_STRICT_CONCURRENCY = complete;
\t\t\t\tSWIFT_VERSION = 6.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t\tTEST_HOST = "$(BUILT_PRODUCTS_DIR)/RubatoChatDemo.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/RubatoChatDemo";
\t\t\t}};
\t\t\tname = {name};
\t\t}};'''

objects.append(test_settings(test_debug, "Debug"))
objects.append(test_settings(test_release, "Release"))

# Configuration lists
objects.append(f'''\t\t{project_config_list_id} /* Build configuration list for PBXProject "RubatoChatDemo" */ = {{
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = ({project_debug} /* Debug */, {project_release} /* Release */);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t}};''')
objects.append(f'''\t\t{app_config_list_id} /* Build configuration list for PBXNativeTarget "RubatoChatDemo" */ = {{
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = ({app_debug} /* Debug */, {app_release} /* Release */);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t}};''')
objects.append(f'''\t\t{test_config_list_id} /* Build configuration list for PBXNativeTarget "RubatoChatDemoTests" */ = {{
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = ({test_debug} /* Debug */, {test_release} /* Release */);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t}};''')

# Swift package
objects.append(f'''\t\t{package_ref_id} /* XCRemoteSwiftPackageReference "ChatLayout" */ = {{
\t\t\tisa = XCRemoteSwiftPackageReference;
\t\t\trepositoryURL = "https://github.com/ekazaev/ChatLayout.git";
\t\t\trequirement = {{ kind = revision; revision = {CHAT_LAYOUT_REVISION}; }};
\t\t}};''')
objects.append(f'''\t\t{package_product_id} /* ChatLayout */ = {{
\t\t\tisa = XCSwiftPackageProductDependency;
\t\t\tpackage = {package_ref_id} /* XCRemoteSwiftPackageReference "ChatLayout" */;
\t\t\tproductName = ChatLayout;
\t\t}};''')

content = f'''// !$*UTF8*$!
{{
\tarchiveVersion = 1;
\tclasses = {{}};
\tobjectVersion = 56;
\tobjects = {{
{chr(10).join(objects)}
\t}};
\trootObject = {project_id} /* Project object */;
}}
'''
PROJECT.mkdir(parents=True, exist_ok=True)
PBXPROJ.write_text(content)
print(f"wrote {PBXPROJ} with {len(source_files)} app files and {len(test_files)} test files")
