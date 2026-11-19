---
name: spring-boot-appointments-backend
description: Edits the Spring Boot JVM backend in src/main/java/com/clinic/appointments (controller, repository, entity) and its Gradle build. Use for any change to appointment booking code.
model: sonnet
effort: medium
---

## Area

Owns `src/main/java/com/clinic/appointments/` and `build.gradle.kts`. Does not touch applied database migrations or the front desk UI, which this repo does not have yet.

## Stack

Spring Boot with Spring Web and Spring Data JPA on PostgreSQL, built with Gradle (`build.gradle.kts`). JPA, not R2DBC. Layers in use: `AppointmentController.java`, `AppointmentRepository.java`, `Appointment.java`.

## Standards

1. A controller takes its repository through the constructor and keeps it `final`, as `src/main/java/com/clinic/appointments/AppointmentController.java` does; no field `@Autowired`.
2. A controller method returns `ResponseEntity` and maps a missing row to `notFound()`, as `src/main/java/com/clinic/appointments/AppointmentController.java` does; it never calls `Optional.get()` without a check.
3. Lookups go through a derived query method on the `JpaRepository` interface, as `findByClinicianIdAndStartsAtBetween` in `src/main/java/com/clinic/appointments/AppointmentRepository.java`; no hand-built `EntityManager` query for a lookup a derived method can express.
4. A JPA `@Entity` that holds patient data is not returned from a controller; return a DTO. The repo returns `Appointment` itself today (`src/main/java/com/clinic/appointments/Appointment.java`), so a new endpoint adds the DTO (ecosystem idiom, marked as such).
5. A new `implementation(...)` line in `build.gradle.kts` carries no version: the Spring Boot BOM from the dependency-management plugin owns it.
6. An `@Entity` field that holds a closed set of values (`status` in `src/main/java/com/clinic/appointments/Appointment.java`) changes together with the comment that lists the values and every `status` check, in one commit.

## Proving it works

The commands live in `README.md`; run tests through the Gradle wrapper it names, never a raw `gradle` call. Report the command, its result, and the endpoint response you saw.

## Skills

Load a Spring Boot skill if the session lists one.

## Review checklist

- Field injection or `.get()` on an `Optional` in a controller.
- An `@Entity` returned from a controller.
- A version on a BOM-managed dependency in `build.gradle.kts`.
- A new `status` value without the matching list and checks.
