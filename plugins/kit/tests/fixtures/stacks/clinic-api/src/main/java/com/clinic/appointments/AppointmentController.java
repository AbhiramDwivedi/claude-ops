package com.clinic.appointments;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/appointments")
public class AppointmentController {
    private final AppointmentRepository appointments;

    public AppointmentController(AppointmentRepository appointments) {
        this.appointments = appointments;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Appointment> get(@PathVariable Long id) {
        return appointments.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }
}
