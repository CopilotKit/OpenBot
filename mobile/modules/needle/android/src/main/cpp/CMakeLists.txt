cmake_minimum_required(VERSION 3.22)
project(openbotneedle)

# Needle's prebuilt engine for Android, put here by `npm run get-needle` (see modules/needle/README.md).
# Without it the app still builds, and the Phone Bot screen says Needle is missing.
set(NEEDLE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libs/${ANDROID_ABI})
add_library(openbotneedle SHARED needle-jni.cpp)
if(EXISTS ${NEEDLE_DIR}/libneedle.a)
  add_library(needle STATIC IMPORTED)
  set_target_properties(needle PROPERTIES IMPORTED_LOCATION ${NEEDLE_DIR}/libneedle.a)
  target_link_libraries(openbotneedle needle log android m)
else()
  target_compile_definitions(openbotneedle PRIVATE NEEDLE_MISSING=1)
  target_link_libraries(openbotneedle log)
endif()
